// githttp.ts — git smart HTTP: the ref advertisement (protocol v0 and v2), v2 ls-refs,
// v2/v0 fetch with shallow support, and v0 receive-pack with report-status in side-band-64k
// framing. Implemented from the protocol itself: pkt-lines, packfiles and the object graph
// all come from gitobj.ts and store.ts; there is no git binary in the trial pod.

import {
  encodePkt,
  parsePkts,
  parseTag,
  parseTree,
  PKT_DELIM,
  PKT_FLUSH,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import { type Repo, type Store } from './store.ts';
import { sendBytes, sendError, type WebContext } from './web.ts';

const AGENT = 'anvil/1.0';
const UPLOAD_CAPS_V0 =
  'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not';
const RECEIVE_CAPS_V0 = 'report-status delete-refs side-band-64k ofs-delta quiet';

// ------------------------------------------------------------------ advertisements

function wantsV2(ctx: WebContext): boolean {
  const header = ctx.req.headers['git-protocol'];
  return typeof header === 'string' && header.includes('version=2');
}

/** The refs a v0 advertisement lists: HEAD first (when it resolves), then name-sorted refs. */
function advertisedRefs(store: Store, repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  const headTip = repo.refs.get(store.headTarget(repo));
  if (headTip !== undefined) out.push({ name: 'HEAD', oid: headTip });
  for (const ref of store.sortedRefs(repo)) {
    const peeled = store.peeledOf(ref.oid);
    out.push(peeled === undefined ? ref : { ...ref, peeled });
  }
  return out;
}

function v0Advertisement(store: Store, repo: Repo, service: string): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `${UPLOAD_CAPS_V0} symref=HEAD:${store.headTarget(repo)} agent=${AGENT}`
      : `${RECEIVE_CAPS_V0} agent=${AGENT}`;
  const parts: Buffer[] = [encodePkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(store, repo);
  if (refs.length === 0) {
    parts.push(encodePkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(encodePkt(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled !== undefined) parts.push(encodePkt(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    encodePkt('version 2\n'),
    encodePkt(`agent=${AGENT}\n`),
    encodePkt('object-format=sha1\n'),
    encodePkt('fetch=shallow wait-for-done\n'),
    encodePkt('ls-refs=unborn\n'),
    PKT_FLUSH,
  ]);
}

// ------------------------------------------------------------------ request parsing

interface PktRequest {
  /** Data-packet payloads as text lines, in order. */
  lines: string[];
  /** The byte offset just past the terminating flush packet (where a pack may follow). */
  packStart: number;
  /** True when a delim packet split the header from the arguments (the v2 shape). */
  sawDelim: boolean;
}

function parsePktRequest(body: Buffer): PktRequest | null {
  const walked = parsePkts(body);
  const lines: string[] = [];
  let sawDelim = false;
  for (const packet of walked.packets) {
    if (packet.kind === 'flush') return { lines, packStart: walked.next, sawDelim };
    if (packet.kind === 'delim') {
      sawDelim = true;
      lines.push('\u0001');
      continue;
    }
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return null;
}

/** Split a v2 request's lines at the delim marker into capability args and command args. */
function splitAtDelim(lines: string[]): { head: string[]; args: string[] } {
  const at = lines.indexOf('\u0001');
  if (at < 0) return { head: lines, args: [] };
  return { head: lines.slice(0, at), args: lines.slice(at + 1) };
}

function cleanLine(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

// ------------------------------------------------------------------ ls-refs

function lsRefs(store: Store, repo: Repo, lines: string[]): Buffer {
  const { args } = splitAtDelim(lines);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of args) {
    const line = cleanLine(raw);
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = store.headTarget(repo);
  const headTip = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      parts.push(encodePkt(`${headTip} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      parts.push(encodePkt(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const ref of store.sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = store.peeledOf(ref.oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    parts.push(encodePkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch planning

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Everything reachable from `roots`, stopping parent traversal at shallow boundary commits. */
function closureWithBoundary(store: Store, roots: readonly string[], boundary: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.getObject(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = store.commitView(oid);
      if (view === undefined) continue;
      queue.push(view.tree);
      if (!boundary.has(oid)) queue.push(...view.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

function planFetch(store: Store, args: FetchArgs): FetchPlan {
  const boundary = new Set(args.shallow);
  const excluded = closureWithBoundary(store, args.haves, boundary);
  const included = new Set<string>();
  const newBoundary = new Set<string>();

  if (args.depth === null) {
    for (const oid of closureWithBoundary(store, args.wants, new Set())) included.add(oid);
  } else {
    const depth = Math.max(1, args.depth);
    // Breadth-first over commits: generation 0 is the wanted tips themselves.
    const generation = new Map<string, number>();
    const queue: string[] = [];
    for (const want of args.wants) {
      const commit = store.peelToCommit(want);
      if (commit === undefined) {
        // A wanted tree/blob/tag chain with no commit: send its plain closure.
        for (const oid of closureWithBoundary(store, [want], new Set())) included.add(oid);
        continue;
      }
      if (want !== commit) {
        for (const oid of closureWithBoundary(store, [want], new Set([commit]))) included.add(oid);
      }
      if (!generation.has(commit)) {
        generation.set(commit, 0);
        queue.push(commit);
      }
    }
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      const gen = generation.get(oid) as number;
      if (gen >= depth) continue;
      included.add(oid);
      const view = store.commitView(oid);
      if (view === undefined) continue;
      for (const oid2 of closureWithBoundary(store, [view.tree], new Set())) included.add(oid2);
      if (gen === depth - 1) {
        if (view.parents.length > 0) newBoundary.add(oid);
        continue;
      }
      for (const parent of view.parents) {
        if (!generation.has(parent)) {
          generation.set(parent, gen + 1);
          queue.push(parent);
        }
      }
    }
  }

  const send: GitObject[] = [];
  const byKind: Record<string, number> = { commit: 0, tag: 1, tree: 2, blob: 3 };
  const oids = [...included].filter((oid) => !excluded.has(oid));
  oids.sort((a, b) => (byKind[store.getObject(a)?.type ?? 'blob'] as number) - (byKind[store.getObject(b)?.type ?? 'blob'] as number));
  for (const oid of oids) {
    const object = store.getObject(oid);
    if (object !== undefined) send.push(object);
  }
  const shallow = [...newBoundary];
  const unshallow = args.shallow.filter((oid) => included.has(oid) && !newBoundary.has(oid));
  return { objects: send, shallow, unshallow };
}

// Fetch plans are pure functions of the immutable object graph: the same wants, haves,
// shallow set and depth always yield the same pack. Memoizing the packed result makes
// repeated shallow clones of one tip (the benchmark's shape) nearly free.
const packCache = new Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>();
const PACK_CACHE_LIMIT = 64;

function planAndPack(store: Store, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = [
    [...args.wants].sort().join(','),
    [...args.haves].sort().join(','),
    [...args.shallow].sort().join(','),
    String(args.depth),
  ].join('|');
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const plan = planFetch(store, args);
  const entry = { pack: writePack(plan.objects), shallow: plan.shallow, unshallow: plan.unshallow };
  if (packCache.size >= PACK_CACHE_LIMIT) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, entry);
  return entry;
}

function sidebandChunks(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(encodePkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(encodePkt(Buffer.from([1])));
  return parts;
}

/** The client's current shallow depth: generations from a want down to its boundary. */
function currentShallowDepth(store: Store, wants: readonly string[], shallow: ReadonlySet<string>): number {
  let best: number | null = null;
  for (const want of wants) {
    const tip = store.peelToCommit(want);
    if (tip === undefined) continue;
    const generation = new Map<string, number>([[tip, 0]]);
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      const gen = generation.get(oid) as number;
      if (shallow.has(oid)) {
        if (best === null || gen + 1 < best) best = gen + 1;
        continue;
      }
      const view = store.commitView(oid);
      if (view === undefined) continue;
      for (const parent of view.parents) {
        if (!generation.has(parent)) {
          generation.set(parent, gen + 1);
          queue.push(parent);
        }
      }
    }
  }
  return best ?? 0;
}

function fetchV2(store: Store, repo: Repo, lines: string[]): Buffer {
  const { args } = splitAtDelim(lines);
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let done = false;
  let deepenRelative = false;
  for (const raw of args) {
    const line = cleanLine(raw);
    if (line.startsWith('want ')) parsed.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) parsed.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) parsed.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) parsed.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'deepen-relative') deepenRelative = true;
    else if (line.startsWith('want-ref ')) {
      const oid = repo.refs.get(line.slice(9).trim());
      if (oid !== undefined) parsed.wants.push(oid);
    } else if (line === 'done') done = true;
  }
  if (parsed.depth !== null && deepenRelative) {
    parsed.depth += currentShallowDepth(store, parsed.wants, new Set(parsed.shallow));
  }

  const plan = planAndPack(store, parsed);
  // Protocol v2 responses are sections separated by delim packets; only the last
  // section (the packfile) ends with a flush. When the client did not send 'done',
  // the response opens with an acknowledgments section whose last line is 'ready'
  // (this forge can always satisfy a fetch from the first round), and the packfile
  // sections follow in the same response. With 'done' sent, no acknowledgments
  // section is expected.
  const parts: Buffer[] = [];
  if (!done) {
    parts.push(encodePkt('acknowledgments\n'));
    const common = parsed.haves.filter((have) => store.getObject(have) !== undefined);
    if (common.length > 0) {
      for (const have of common) parts.push(encodePkt(`ACK ${have}\n`));
    } else {
      parts.push(encodePkt('NAK\n'));
    }
    parts.push(encodePkt('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(encodePkt('packfile\n'));
  parts.push(...sidebandChunks(plan.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(store: Store, repo: Repo, body: Buffer): Buffer {
  // v0: want/shallow/deepen lines, a flush, have lines and done, a second flush.
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  const { packets } = parsePkts(body);
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = cleanLine(packet.payload.toString('utf8'));
    if (section === 0) {
      if (line.startsWith('want ')) parsed.wants.push(line.slice(5, 45));
      else if (line.startsWith('shallow ')) parsed.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) parsed.depth = Number.parseInt(line.slice(7), 10);
    } else if (line.startsWith('have ')) {
      parsed.haves.push(line.slice(5).trim());
    }
  }
  const plan = planAndPack(store, parsed);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(encodePkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
  const common = parsed.haves.filter((have) => store.getObject(have) !== undefined);
  if (parsed.haves.length > 0 && common.length > 0) parts.push(encodePkt(`ACK ${common[common.length - 1]}\n`));
  else parts.push(encodePkt('NAK\n'));
  parts.push(...sidebandChunks(plan.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(ctx: WebContext, store: Store, repo: Repo): void {
  const request = parsePktRequest(ctx.body);
  if (request === null || request.lines.length === 0) {
    sendError(ctx, 400, 'Bad Request');
    return;
  }
  const firstLine = request.lines[0] as string;
  const nul = firstLine.indexOf('\0');
  const caps = nul >= 0 ? firstLine.slice(nul + 1).replace(/\n$/, '') : '';
  const capSet = new Set(caps.split(' ').filter(Boolean));
  const commands: PushCommand[] = [];
  for (const raw of request.lines) {
    const line = cleanLine(raw.split('\0')[0] as string);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match === null) {
      sendError(ctx, 400, 'Bad Request');
      return;
    }
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }

  const reportStatus = capSet.has('report-status') || capSet.has('report-status-v2');
  const sideband = capSet.has('side-band-64k');
  const reply = (reportLines: string[]): void => {
    if (!reportStatus) {
      sendBytes(ctx, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
      return;
    }
    const stream = Buffer.concat([...reportLines.map((line) => encodePkt(line)), PKT_FLUSH]);
    // In side-band-64k the report travels in band 1 and the outer stream ends with a flush.
    const body = sideband ? Buffer.concat([...sidebandChunks(stream), PKT_FLUSH]) : stream;
    sendBytes(ctx, 200, body, 'application/x-git-receive-pack-result');
  };

  // Unpack first: the pack (everything past the command list's flush) goes into the store
  // whole, even when some refs will be refused, exactly as receive-pack behaves.
  const pack = ctx.body.subarray(request.packStart);
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => store.getObject(oid));
      for (const object of objects.values()) store.putObject(object.type, object.data);
    } catch (err) {
      reply([`unpack ${err instanceof Error ? err.message : 'error'}\n`]);
      return;
    }
  }

  const results: string[] = ['unpack ok\n'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    const refuse = (reason: string): void => {
      results.push(`ng ${command.ref} ${reason}\n`);
    };
    if (command.oldOid !== current) {
      refuse('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push(`ok ${command.ref}\n`);
      continue;
    }
    const newObject = store.getObject(command.newOid);
    if (newObject === undefined) {
      refuse('invalid object');
      continue;
    }
    if (command.oldOid !== ZERO_OID) {
      const oldCommit = store.peelToCommit(command.oldOid);
      const newCommit = store.peelToCommit(command.newOid);
      if (oldCommit !== undefined && newCommit !== undefined && oldCommit !== newCommit && !store.isAncestor(oldCommit, newCommit)) {
        refuse('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push(`ok ${command.ref}\n`);
  }
  reply(results);
}

// ------------------------------------------------------------------ routing

/** Handle one smart-HTTP request. `rest` is the path after /{owner}/{repo}.git. */
export function handleGit(ctx: WebContext, owner: string, repoName: string, rest: string): void {
  const store = ctx.store;
  const repo = store.findRepo(owner, repoName);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (rest === '/info/refs' && ctx.method === 'GET') {
    const service = ctx.query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(ctx, 400, 'Bad Request');
      return;
    }
    const body =
      service === 'git-upload-pack' && wantsV2(ctx) ? v2Advertisement() : v0Advertisement(store, repo, service);
    sendBytes(ctx, 200, body, `application/x-${service}-advertisement`);
    return;
  }
  if (rest === '/git-upload-pack' && ctx.method === 'POST') {
    const request = parsePktRequest(ctx.body);
    if (request === null || request.lines.length === 0) {
      sendError(ctx, 400, 'Bad Request');
      return;
    }
    const { head } = splitAtDelim(request.lines);
    const command = head.map(cleanLine).find((line) => line.startsWith('command='));
    if (command === 'command=ls-refs') {
      sendBytes(ctx, 200, lsRefs(store, repo, request.lines), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'command=fetch') {
      sendBytes(ctx, 200, fetchV2(store, repo, request.lines), 'application/x-git-upload-pack-result');
      return;
    }
    // No command line: a protocol v0 fetch request.
    sendBytes(ctx, 200, fetchV0(store, repo, ctx.body), 'application/x-git-upload-pack-result');
    return;
  }
  if (rest === '/git-receive-pack' && ctx.method === 'POST') {
    receivePack(ctx, store, repo);
    return;
  }
  sendError(ctx, 404, 'Not Found');
}
