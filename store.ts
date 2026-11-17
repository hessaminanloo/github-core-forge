// store.ts — Anvil's in-memory state: one object store for every repository's git objects
// (content-addressed, so sharing is free), the repository records with their refs, issues,
// pull requests, labels and comments, and the graph walks the protocol layers need
// (ancestry, merge bases, tree flatten/build, three-way tree merges, tree diffs).
//
// Time comes from a logical clock seeded by MAKEFUN_TRIAL_NOW when the harness provides it:
// timestamps stay monotonic in creation order and identical between a live run and its
// replay, because no wall clock is ever read.

import {
  buildCommit,
  buildTree,
  hashObject,
  identLine,
  isOid,
  isTreeMode,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type Identity,
  type ObjType,
  type TreeEntry,
} from './gitobj.ts';

export interface Viewer {
  login: string;
  id: number;
  name: string;
  email: string;
}

/** The one account the trial token belongs to (the suite's seeded scenario names it). */
export const VIEWER: Viewer = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: number;
  updatedAt: number;
  refs: Map<string, string>;
  nextNumber: number;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
}

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  readonly commentsById = new Map<number, { repo: Repo; issue: Issue; comment: Comment }>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextLabelId = 1;
  private nextCommentId = 1;
  private clockSec: number;

  constructor() {
    const trialNow = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = Date.parse(trialNow);
    this.clockSec = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1_735_689_600;
  }

  /** The next logical timestamp: strictly increasing, one second per event. */
  now(): number {
    this.clockSec += 1;
    return this.clockSec;
  }

  iso(sec: number): string {
    return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  readonly identity: Identity = { name: VIEWER.name, email: VIEWER.email };

  // -------------------------------------------------------------- objects

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** The commit a ref-ish oid names, peeling annotated tags; undefined when it is not one. */
  peelToCommit(oid: string): string | undefined {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  commitView(oid: string): ReturnType<typeof parseCommit> | undefined {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return undefined;
    return parseCommit(object.data);
  }

  // -------------------------------------------------------------- repositories

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  createRepo(name: string, options: { description?: string; isPrivate?: boolean }): Repo {
    const now = this.now();
    const repo: Repo = {
      id: this.nextRepoId,
      owner: VIEWER.login,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      nextNumber: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(repo.owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  /** A repository is visible only under its owner's login: any other owner is a 404. */
  findRepo(owner: string, name: string): Repo | undefined {
    if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    this.reposById.delete(repo.id);
  }

  listRepos(): Repo[] {
    return [...this.reposById.values()].sort((a, b) => a.id - b.id);
  }

  // -------------------------------------------------------------- refs and branches

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  headTarget(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** Every advertised ref (heads and tags), name-sorted, HEAD handled by the caller. */
  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The peeled commit of an annotated tag ref, when the ref names a tag object. */
  peeledOf(oid: string): string | undefined {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'tag') return undefined;
    return this.peelToCommit(oid);
  }

  // -------------------------------------------------------------- ancestry

  /** Every commit reachable from `tip` (inclusive), following parents. */
  commitClosure(tip: string): Set<string> {
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const view = this.commitView(oid);
      if (view === undefined) continue;
      seen.add(oid);
      for (const parent of view.parents) queue.push(parent);
    }
    return seen;
  }

  /** True when `ancestor` is `descendant` itself or one of its ancestors. */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.commitClosure(descendant).has(ancestor);
  }

  /** A best common ancestor of two commits (the first BFS hit from `b` inside a's closure). */
  mergeBase(a: string, b: string): string | undefined {
    if (a === b) return a;
    const closureA = this.commitClosure(a);
    if (closureA.has(b)) return b;
    if (this.commitClosure(b).has(a)) return a;
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (closureA.has(oid)) return oid;
      const view = this.commitView(oid);
      if (view !== undefined) queue.push(...view.parents);
    }
    return undefined;
  }

  /** Commits reachable from `tip`, newest first (children before parents), for listings. */
  historyFrom(tip: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      const view = this.commitView(oid);
      if (view === undefined) continue;
      seen.add(oid);
      order.push(oid);
      queue.push(...view.parents);
    }
    return order;
  }

  // -------------------------------------------------------------- trees

  /** Flatten a tree (recursively) into path -> {oid, mode}. */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (isTreeMode(entry.mode)) walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) nested trees from a flat path -> {oid, mode} map; returns the root tree id. */
  buildTreeFromFiles(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index] as string;
        if (!node.dirs.has(segment)) node.dirs.set(segment, { files: new Map(), dirs: new Map() });
        node = node.dirs.get(segment) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, file);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** The flattened files of a commit (empty for an unknown commit). */
  filesOfCommit(commitOid: string): Map<string, { oid: string; mode: string }> {
    const view = this.commitView(commitOid);
    if (view === undefined) return new Map();
    return this.flattenTree(view.tree);
  }

  // -------------------------------------------------------------- commits made by the forge

  /**
   * Commit file changes on a branch: `changes` maps a path to its new bytes, or null to
   * delete it. The branch is created when it does not exist (forking the default branch's
   * tip, or unborn when the repository has no commits). Returns the new commit id.
   */
  commitFiles(
    repo: Repo,
    branch: string,
    changes: ReadonlyMap<string, Buffer | null>,
    message: string,
  ): string {
    const ref = `refs/heads/${branch}`;
    let parent = repo.refs.get(ref);
    if (parent === undefined && branch !== repo.defaultBranch) {
      parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    const files = parent === undefined ? new Map<string, { oid: string; mode: string }>() : this.filesOfCommit(parent);
    for (const [path, content] of changes) {
      if (content === null) files.delete(path);
      else files.set(path, { oid: this.putObject('blob', content), mode: '100644' });
    }
    const tree = this.buildTreeFromFiles(files);
    const stamp = identLine(this.identity, this.now());
    const commit = buildCommit({
      tree,
      parents: parent === undefined ? [] : [parent],
      author: stamp,
      committer: stamp,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const oid = this.putObject('commit', commit);
    repo.refs.set(ref, oid);
    repo.updatedAt = this.now();
    return oid;
  }

  /** A single-purpose commit (a merge result): explicit tree and parents on a branch. */
  commitTree(repo: Repo, branch: string, tree: string, parents: readonly string[], message: string): string {
    const stamp = identLine(this.identity, this.now());
    const commit = buildCommit({
      tree,
      parents,
      author: stamp,
      committer: stamp,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const oid = this.putObject('commit', commit);
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.updatedAt = this.now();
    return oid;
  }

  // -------------------------------------------------------------- merges and diffs

  /**
   * A three-way merge of flattened file maps. Returns the merged map, or the list of
   * conflicting paths when both sides changed the same path differently.
   */
  mergeFileMaps(
    base: ReadonlyMap<string, { oid: string; mode: string }>,
    ours: ReadonlyMap<string, { oid: string; mode: string }>,
    theirs: ReadonlyMap<string, { oid: string; mode: string }>,
  ): { merged: Map<string, { oid: string; mode: string }> } | { conflicts: string[] } {
    const merged = new Map<string, { oid: string; mode: string }>();
    const conflicts: string[] = [];
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = base.get(path)?.oid;
      const o = ours.get(path)?.oid;
      const t = theirs.get(path)?.oid;
      if (o === t) {
        if (o !== undefined) merged.set(path, ours.get(path) ?? (theirs.get(path) as { oid: string; mode: string }));
        continue;
      }
      if (b === o) {
        if (t !== undefined) merged.set(path, theirs.get(path) as { oid: string; mode: string });
        continue;
      }
      if (b === t) {
        if (o !== undefined) merged.set(path, ours.get(path) as { oid: string; mode: string });
        continue;
      }
      conflicts.push(path);
    }
    return conflicts.length > 0 ? { conflicts } : { merged };
  }

  /** Whether merging `headRef` into `baseRef` of `repo` is clean, and its merged file map. */
  pullMergePlan(repo: Repo, pull: Pull):
    | { ok: true; merged: Map<string, { oid: string; mode: string }>; baseTip: string; headTip: string }
    | { ok: false; reason: 'conflict' | 'missing' } {
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (baseTip === undefined || headTip === undefined) return { ok: false, reason: 'missing' };
    const baseCommit = this.peelToCommit(baseTip);
    const headCommit = this.peelToCommit(headTip);
    if (baseCommit === undefined || headCommit === undefined) return { ok: false, reason: 'missing' };
    const ancestor = this.mergeBase(baseCommit, headCommit);
    const baseFiles = ancestor === undefined ? new Map() : this.filesOfCommit(ancestor);
    const result = this.mergeFileMaps(baseFiles, this.filesOfCommit(baseCommit), this.filesOfCommit(headCommit));
    if ('conflicts' in result) return { ok: false, reason: 'conflict' };
    return { ok: true, merged: result.merged, baseTip: baseCommit, headTip: headCommit };
  }

  /** Squash-merge a pull request: one commit with the merged tree on the base branch. */
  squashMerge(repo: Repo, pull: Pull): { sha: string } | { conflict: true } | { missing: true } {
    const plan = this.pullMergePlan(repo, pull);
    if (!plan.ok) return plan.reason === 'conflict' ? { conflict: true } : { missing: true };
    const tree = this.buildTreeFromFiles(plan.merged);
    const sha = this.commitTree(repo, pull.baseRef, tree, [plan.baseTip], `${pull.title} (#${pull.number})\n\n${pull.body}`.trimEnd());
    const now = this.now();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = now;
    pull.closedAt = now;
    pull.updatedAt = now;
    pull.mergeCommitSha = sha;
    return { sha };
  }

  /** Changed paths between a base commit and a head commit, via their merge base. */
  diffFiles(
    repo: Repo,
    baseCommit: string,
    headCommit: string,
  ): Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }> {
    const ancestor = this.mergeBase(baseCommit, headCommit);
    const before = ancestor === undefined ? new Map<string, { oid: string; mode: string }>() : this.filesOfCommit(ancestor);
    const after = this.filesOfCommit(headCommit);
    const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }> = [];
    const paths = new Set<string>([...before.keys(), ...after.keys()]);
    for (const path of [...paths].sort()) {
      const b = before.get(path);
      const a = after.get(path);
      if (b !== undefined && a !== undefined && b.oid === a.oid) continue;
      if (b === undefined && a !== undefined) {
        out.push({ path, status: 'added', additions: this.lineCount(a.oid), deletions: 0 });
      } else if (a === undefined && b !== undefined) {
        out.push({ path, status: 'removed', additions: 0, deletions: this.lineCount(b.oid) });
      } else if (a !== undefined && b !== undefined) {
        const counts = this.lineDiff(b.oid, a.oid);
        out.push({ path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
      }
    }
    return out;
  }

  private lineCount(blobOid: string): number {
    const object = this.objects.get(blobOid);
    if (object === undefined) return 0;
    const text = object.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }

  /** A line-level diff count by longest-common-subsequence over lines (files here are small). */
  private lineDiff(oldOid: string, newOid: string): { additions: number; deletions: number } {
    const oldText = this.objects.get(oldOid)?.data.toString('utf8') ?? '';
    const newText = this.objects.get(newOid)?.data.toString('utf8') ?? '';
    const oldLines = oldText === '' ? [] : oldText.split('\n');
    const newLines = newText === '' ? [] : newText.split('\n');
    if (oldLines.length * newLines.length > 4_000_000) {
      return { additions: newLines.length, deletions: oldLines.length };
    }
    const dp: number[] = new Array(newLines.length + 1).fill(0);
    for (let i = oldLines.length - 1; i >= 0; i -= 1) {
      let diagonal = 0;
      for (let j = newLines.length - 1; j >= 0; j -= 1) {
        const above = dp[j] as number;
        if (oldLines[i] === newLines[j]) dp[j] = diagonal + 1;
        else dp[j] = Math.max(dp[j] as number, dp[j + 1] as number);
        diagonal = above;
      }
    }
    const common = dp[0] as number;
    return { additions: newLines.length - common, deletions: oldLines.length - common };
  }

  // -------------------------------------------------------------- issues, pulls, labels

  createLabel(repo: Repo, name: string, color: string, description: string | null): Label {
    const existing = repo.labels.get(name.toLowerCase());
    if (existing !== undefined) return existing;
    const label: Label = { id: this.nextLabelId, name, color, description };
    this.nextLabelId += 1;
    repo.labels.set(name.toLowerCase(), label);
    return label;
  }

  createIssue(repo: Repo, input: { title: string; body: string; labels: string[] }): Issue {
    const now = this.now();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...input.labels],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      comments: [],
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const now = this.now();
    const comment: Comment = { id: this.nextCommentId, body, createdAt: now, updatedAt: now };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    issue.updatedAt = now;
    this.commentsById.set(comment.id, { repo, issue, comment });
    return comment;
  }

  createPull(repo: Repo, input: { title: string; body: string; headRef: string; baseRef: string }): Pull {
    const now = this.now();
    const pull: Pull = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.headRef,
      baseRef: input.baseRef,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** An open pull request for the same head/base pair, when one exists. */
  openPullFor(repo: Repo, headRef: string, baseRef: string): Pull | undefined {
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) return pull;
    }
    return undefined;
  }
}

export { ZERO_OID, isOid };
