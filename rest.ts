// rest.ts — the REST v3 surface: root and meta, the viewer, repository CRUD with Link-header
// pagination, the contents API (create/update/delete with sha conflict discipline), git
// refs, branches and commit listings, labels, issues with comments, and pull requests with
// squash merges. Every reply is JSON with a request id; errors are {message} bodies.

import { hashObject, isOid, parseCommit, ZERO_OID } from './gitobj.ts';
import { VIEWER, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { boolField, jsonBody, notFound, sendError, sendJson, stringField, type WebContext } from './web.ts';

// ------------------------------------------------------------------ serializers

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: `U_${VIEWER.id}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function originOf(ctx: WebContext): string {
  const host = ctx.req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

export function repoJson(ctx: WebContext, repo: Repo): Record<string, unknown> {
  const origin = originOf(ctx);
  const openCount = [...repo.issues.values(), ...repo.pulls.values()].filter((item) => item.state === 'open').length;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${origin}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${origin.replace(/^https?:\/\//, '')}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${origin.replace(/^https?:\/\//, '')}:${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: ctx.store.iso(repo.createdAt),
    updated_at: ctx.store.iso(repo.updatedAt),
    pushed_at: ctx.store.iso(repo.updatedAt),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openCount,
    has_issues: true,
    has_projects: false,
    has_downloads: false,
    has_wiki: false,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    license: null,
    topics: [],
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(repo: Repo, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name.toLowerCase());
  if (label === undefined) return null;
  return { id: label.id, node_id: `LA_${label.id}`, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(ctx: WebContext, repo: Repo, issue: Issue): Record<string, unknown> {
  const origin = originOf(ctx);
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)).filter((label) => label !== null),
    user: userJson(),
    comments: issue.comments.length,
    created_at: ctx.store.iso(issue.createdAt),
    updated_at: ctx.store.iso(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : ctx.store.iso(issue.closedAt),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    author_association: 'OWNER',
  };
}

export function commentJson(ctx: WebContext, repo: Repo, issue: Issue, commentId: number): Record<string, unknown> | null {
  const comment = issue.comments.find((entry) => entry.id === commentId);
  if (comment === undefined) return null;
  const origin = originOf(ctx);
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: ctx.store.iso(comment.createdAt),
    updated_at: ctx.store.iso(comment.updatedAt),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

function refJson(ctx: WebContext, repo: Repo, refName: string): Record<string, unknown> {
  const tip = ctx.store.branchTip(repo, refName) ?? ZERO_OID;
  return {
    label: `${repo.owner}:${refName}`,
    ref: refName,
    sha: tip,
    user: userJson(),
    repo: repoJson(ctx, repo),
  };
}

export function pullJson(ctx: WebContext, repo: Repo, pull: Pull): Record<string, unknown> {
  const origin = originOf(ctx);
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    draft: false,
    created_at: ctx.store.iso(pull.createdAt),
    updated_at: ctx.store.iso(pull.updatedAt),
    closed_at: pull.closedAt === null ? null : ctx.store.iso(pull.closedAt),
    merged_at: pull.mergedAt === null ? null : ctx.store.iso(pull.mergedAt),
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: refJson(ctx, repo, pull.headRef),
    base: refJson(ctx, repo, pull.baseRef),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    author_association: 'OWNER',
    maintainer_can_modify: false,
  };
}

// ------------------------------------------------------------------ helpers

/** Page through a list, emitting GitHub-style absolute Link headers. */
function paginate<T>(ctx: WebContext, items: readonly T[], serialize: (item: T) => unknown): void {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const origin = originOf(ctx);
  const urlFor = (target: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('page', String(target));
    params.set('per_page', String(perPage));
    return `<${origin}${ctx.pathname}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`${urlFor(page + 1)}; rel="next"`, `${urlFor(totalPages)}; rel="last"`);
  }
  if (page > 1) {
    links.push(`${urlFor(1)}; rel="first"`, `${urlFor(page - 1)}; rel="prev"`);
  }
  sendJson(ctx, 200, slice.map(serialize), links.length > 0 ? { link: links.join(', ') } : {});
}

/** Resolve a ref-ish value (branch, tag, or oid) to a commit id. */
function resolveCommit(store: Store, repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') {
    const tip = repo.refs.get(store.headTarget(repo));
    return tip === undefined ? undefined : store.peelToCommit(tip);
  }
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return store.peelToCommit(branch);
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return store.peelToCommit(tag);
  const anyRef = repo.refs.get(ref.startsWith('refs/') ? ref : `refs/${ref}`);
  if (anyRef !== undefined) return store.peelToCommit(anyRef);
  if (isOid(ref)) return store.peelToCommit(ref);
  return undefined;
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: '', email: '', date: new Date(0).toISOString() };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number.parseInt(match[3] as string, 10) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

function commitJson(ctx: WebContext, oid: string): Record<string, unknown> | null {
  const view = ctx.store.commitView(oid);
  if (view === undefined) return null;
  const author = parseIdent(view.authorLine);
  const committer = parseIdent(view.committerLine);
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      // The API presents the message without the raw object's trailing newline.
      message: view.message.endsWith('\n') ? view.message.slice(0, -1) : view.message,
      tree: { sha: view.tree },
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      comment_count: 0,
    },
    author: author.email === VIEWER.email ? userJson() : null,
    committer: committer.email === VIEWER.email ? userJson() : null,
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

/** The request body as JSON; answers 400 and returns null when it is malformed. */
function bodyOr400(ctx: WebContext): Record<string, unknown> | null {
  const parsed = jsonBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return null;
  }
  return parsed.value;
}

// ------------------------------------------------------------------ repository routes

function createRepo(ctx: WebContext): void {
  const body = bodyOr400(ctx);
  if (body === null) return;
  const name = stringField(body, 'name');
  if (name === undefined || name === '') {
    sendError(ctx, 422, 'Validation Failed: name is required');
    return;
  }
  const existing = ctx.store.findRepo(VIEWER.login, name);
  if (existing !== undefined) {
    sendJson(ctx, 422, { message: 'Validation Failed: name already exists on this account', errors: [{ resource: 'Repository', field: 'name', code: 'custom' }] });
    return;
  }
  const repo = ctx.store.createRepo(name, {
    description: stringField(body, 'description') ?? '',
    isPrivate: boolField(body, 'private') ?? false,
  });
  sendJson(ctx, 201, repoJson(ctx, repo));
}

function getContents(ctx: WebContext, repo: Repo, path: string): void {
  const store = ctx.store;
  const commit = resolveCommit(store, repo, ctx.query.get('ref') ?? undefined);
  const files = commit === undefined ? new Map<string, { oid: string; mode: string }>() : store.filesOfCommit(commit);
  const origin = originOf(ctx);
  const file = files.get(path);
  if (path !== '' && file !== undefined) {
    const object = store.getObject(file.oid);
    const data = object?.data ?? Buffer.alloc(0);
    sendJson(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop(),
      path,
      sha: file.oid,
      content: data.toString('base64'),
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `${origin}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
      download_url: `${origin}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
    });
    return;
  }
  // Directory listing: the immediate children of `path` ('' is the root).
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
  for (const [filePath, info] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      children.set(rest, { type: 'file', oid: info.oid, size: store.getObject(info.oid)?.data.length ?? 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) children.set(dir, { type: 'dir', oid: '', size: 0 });
    }
  }
  if (path !== '' && children.size === 0) {
    notFound(ctx);
    return;
  }
  const entries = [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, info]) => ({
      type: info.type,
      size: info.size,
      name,
      path: prefix + name,
      sha: info.type === 'file' ? info.oid : hashObject('tree', Buffer.alloc(0)),
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${prefix + name}`,
      html_url: `${origin}/${repo.owner}/${repo.name}/${info.type === 'file' ? 'blob' : 'tree'}/${repo.defaultBranch}/${prefix + name}`,
      download_url: info.type === 'file' ? `${origin}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${prefix + name}` : null,
    }));
  sendJson(ctx, 200, entries);
}

function putContents(ctx: WebContext, repo: Repo, path: string): void {
  const body = bodyOr400(ctx);
  if (body === null) return;
  const store = ctx.store;
  const encoded = stringField(body, 'content');
  if (encoded === undefined) {
    sendError(ctx, 422, 'Validation Failed: content is required');
    return;
  }
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const tip = store.branchTip(repo, branch);
  const files = tip === undefined ? new Map<string, { oid: string; mode: string }>() : store.filesOfCommit(store.peelToCommit(tip) ?? '');
  const existing = files.get(path);
  const suppliedSha = stringField(body, 'sha');
  if (existing !== undefined && suppliedSha !== existing.oid) {
    sendJson(ctx, 409, { message: `${path} does not match ${suppliedSha ?? ''}`, errors: [{ resource: 'Contents', field: 'sha', code: 'custom' }] });
    return;
  }
  if (existing === undefined && suppliedSha !== undefined && suppliedSha !== '') {
    sendJson(ctx, 409, { message: `${path} does not exist`, errors: [{ resource: 'Contents', field: 'sha', code: 'custom' }] });
    return;
  }
  const bytes = Buffer.from(encoded.replace(/\s/g, ''), 'base64');
  const message = stringField(body, 'message') ?? (existing === undefined ? `Create ${path}` : `Update ${path}`);
  const commit = store.commitFiles(repo, branch, new Map([[path, bytes]]), message);
  const blobOid = hashObject('blob', bytes);
  sendJson(ctx, existing === undefined ? 201 : 200, {
    content: {
      type: 'file',
      encoding: 'base64',
      size: bytes.length,
      name: path.split('/').pop(),
      path,
      sha: blobOid,
    },
    commit: { sha: commit },
  });
}

function deleteContents(ctx: WebContext, repo: Repo, path: string): void {
  const body = bodyOr400(ctx);
  if (body === null) return;
  const store = ctx.store;
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const tip = store.branchTip(repo, branch);
  const files = tip === undefined ? new Map<string, { oid: string; mode: string }>() : store.filesOfCommit(store.peelToCommit(tip) ?? '');
  const existing = files.get(path);
  if (existing === undefined) {
    notFound(ctx);
    return;
  }
  const suppliedSha = stringField(body, 'sha');
  if (suppliedSha !== existing.oid) {
    sendJson(ctx, 409, { message: `${path} does not match ${suppliedSha ?? ''}` });
    return;
  }
  const commit = store.commitFiles(repo, branch, new Map([[path, null]]), stringField(body, 'message') ?? `Delete ${path}`);
  sendJson(ctx, 200, { content: null, commit: { sha: commit } });
}

// ------------------------------------------------------------------ issues and pulls

function listIssues(ctx: WebContext, repo: Repo): void {
  const state = ctx.query.get('state') ?? 'open';
  let items = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
  const labelsParam = ctx.query.get('labels');
  if (labelsParam !== null && labelsParam !== '') {
    const wanted = labelsParam.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
    items = items.filter((issue) => wanted.every((name) => issue.labels.some((label) => label.toLowerCase() === name)));
  }
  const direction = ctx.query.get('direction') ?? 'desc';
  items.sort((a, b) => (direction === 'asc' ? a.createdAt - b.createdAt || a.number - b.number : b.createdAt - a.createdAt || b.number - a.number));
  paginate(ctx, items, (issue) => issueJson(ctx, repo, issue));
}

function labelNamesOf(body: Record<string, unknown>): string[] {
  const raw = body['labels'];
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

/** The first label name that does not exist on the repo, if any (label typos are a 422). */
function unknownLabel(repo: Repo, names: readonly string[]): string | undefined {
  return names.find((name) => !repo.labels.has(name.toLowerCase()));
}

function createIssue(ctx: WebContext, repo: Repo): void {
  const body = bodyOr400(ctx);
  if (body === null) return;
  const title = stringField(body, 'title');
  if (title === undefined || title === '') {
    sendError(ctx, 422, 'Validation Failed: title is required');
    return;
  }
  const labels = labelNamesOf(body);
  const bad = unknownLabel(repo, labels);
  if (bad !== undefined) {
    sendJson(ctx, 422, { message: `Validation Failed: label "${bad}" does not exist`, errors: [{ resource: 'Issue', field: 'labels', code: 'custom' }] });
    return;
  }
  const issue = ctx.store.createIssue(repo, { title, body: stringField(body, 'body') ?? '', labels });
  sendJson(ctx, 201, issueJson(ctx, repo, issue));
}

function patchIssue(ctx: WebContext, repo: Repo, issue: Issue): void {
  const body = bodyOr400(ctx);
  if (body === null) return;
  const store = ctx.store;
  const title = stringField(body, 'title');
  if (title !== undefined) issue.title = title;
  const text = stringField(body, 'body');
  if (text !== undefined) issue.body = text;
  if (Array.isArray(body['labels'])) {
    const labels = labelNamesOf(body);
    const bad = unknownLabel(repo, labels);
    if (bad !== undefined) {
      sendJson(ctx, 422, { message: `Validation Failed: label "${bad}" does not exist` });
      return;
    }
    issue.labels = labels;
  }
  const state = stringField(body, 'state');
  if (state === 'closed' || state === 'open') {
    issue.state = state;
    issue.closedAt = state === 'closed' ? store.now() : null;
  }
  issue.updatedAt = store.now();
  sendJson(ctx, 200, issueJson(ctx, repo, issue));
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

function createPull(ctx: WebContext, repo: Repo): void {
  const body = bodyOr400(ctx);
  if (body === null) return;
  const store = ctx.store;
  const title = stringField(body, 'title');
  const head = stringField(body, 'head');
  const base = stringField(body, 'base');
  if (title === undefined || head === undefined || base === undefined) {
    sendError(ctx, 422, 'Validation Failed: title, head and base are required');
    return;
  }
  const headRef = stripOwnerPrefix(head);
  const baseRef = stripOwnerPrefix(base);
  if (store.branchTip(repo, headRef) === undefined || store.branchTip(repo, baseRef) === undefined) {
    sendError(ctx, 422, 'Validation Failed: head or base branch does not exist');
    return;
  }
  const existing = store.openPullFor(repo, headRef, baseRef);
  if (existing !== undefined) {
    sendJson(ctx, 422, { message: `Validation Failed: a pull request already exists for ${headRef} into ${baseRef}` });
    return;
  }
  const pull = store.createPull(repo, { title, body: stringField(body, 'body') ?? '', headRef, baseRef });
  sendJson(ctx, 201, pullJson(ctx, repo, pull));
}

function mergePull(ctx: WebContext, repo: Repo, pull: Pull): void {
  const body = bodyOr400(ctx);
  if (body === null) return;
  if (pull.merged) {
    sendJson(ctx, 200, { sha: pull.mergeCommitSha ?? '', merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  if (pull.state === 'closed') {
    sendJson(ctx, 405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest/pulls/pulls#merge-a-pull-request' });
    return;
  }
  const result = ctx.store.squashMerge(repo, pull);
  if ('conflict' in result) {
    sendJson(ctx, 405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest/pulls/pulls#merge-a-pull-request' });
    return;
  }
  if ('missing' in result) {
    notFound(ctx);
    return;
  }
  sendJson(ctx, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}

// ------------------------------------------------------------------ router

export function handleRest(ctx: WebContext): void {
  const store = ctx.store;
  const seg = ctx.segments.slice(2); // after /api/v3
  const method = ctx.method;

  if (seg.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, {
        current_user_url: `${originOf(ctx)}/api/v3/user`,
        repository_url: `${originOf(ctx)}/api/v3/repos/{owner}/{repo}`,
        issue_url: `${originOf(ctx)}/api/v3/repos/{owner}/{repo}/issues{/number}`,
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    notFound(ctx);
    return;
  }

  if (seg[0] === 'meta' && seg.length === 1 && method === 'GET') {
    sendJson(ctx, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      installed_version: '1.0.0-anvil',
      github_services_sha: 'anvil',
    });
    return;
  }

  if (seg[0] === 'user' && seg.length === 1 && method === 'GET') {
    sendJson(ctx, 200, userJson());
    return;
  }

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      paginate(ctx, store.listRepos(), (repo) => repoJson(ctx, repo));
      return;
    }
    if (method === 'POST') {
      createRepo(ctx);
      return;
    }
    notFound(ctx);
    return;
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const repo = store.findRepo(seg[1] as string, seg[2] as string);
    if (repo === undefined) {
      notFound(ctx);
      return;
    }
    const restSeg = seg.slice(3);

    if (restSeg.length === 0) {
      if (method === 'GET') {
        sendJson(ctx, 200, repoJson(ctx, repo));
        return;
      }
      if (method === 'PATCH') {
        const body = bodyOr400(ctx);
        if (body === null) return;
        const description = stringField(body, 'description');
        if (description !== undefined) repo.description = description;
        const priv = boolField(body, 'private');
        if (priv !== undefined) repo.isPrivate = priv;
        const defaultBranch = stringField(body, 'default_branch');
        if (defaultBranch !== undefined && store.branchTip(repo, defaultBranch) !== undefined) repo.defaultBranch = defaultBranch;
        repo.updatedAt = store.now();
        sendJson(ctx, 200, repoJson(ctx, repo));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        ctx.res.writeHead(204, { 'x-github-request-id': `anvil-${ctx.requestSeq.toString(16).padStart(8, '0')}` });
        ctx.res.end();
        return;
      }
      notFound(ctx);
      return;
    }

    if (restSeg[0] === 'contents') {
      const path = restSeg.slice(1).join('/');
      if (method === 'GET') return getContents(ctx, repo, path);
      if (method === 'PUT') return putContents(ctx, repo, path);
      if (method === 'DELETE') return deleteContents(ctx, repo, path);
      notFound(ctx);
      return;
    }

    if (restSeg[0] === 'branches' && restSeg.length === 1 && method === 'GET') {
      const branches = store
        .sortedRefs(repo)
        .filter((ref) => ref.name.startsWith('refs/heads/'))
        .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid }, protected: false }));
      paginate(ctx, branches, (branch) => branch);
      return;
    }

    if (restSeg[0] === 'commits' && restSeg.length === 1 && method === 'GET') {
      const tip = resolveCommit(store, repo, ctx.query.get('sha') ?? undefined);
      const history = tip === undefined ? [] : store.historyFrom(tip);
      paginate(ctx, history, (oid) => commitJson(ctx, oid));
      return;
    }

    if (restSeg[0] === 'git' && restSeg[1] === 'refs' && restSeg.length === 2 && method === 'POST') {
      const body = bodyOr400(ctx);
      if (body === null) return;
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || store.getObject(sha) === undefined) {
        sendError(ctx, 422, 'Validation Failed: ref and sha are required');
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(ctx, 422, { message: 'Validation Failed: reference already exists' });
        return;
      }
      repo.refs.set(ref, sha);
      const object = store.getObject(sha) as { type: string };
      sendJson(ctx, 201, { ref, object: { sha, type: object.type } });
      return;
    }

    if (restSeg[0] === 'git' && restSeg[1] === 'ref' && restSeg.length >= 3 && method === 'GET') {
      const full = `refs/${restSeg.slice(2).join('/')}`;
      const oid = repo.refs.get(full);
      if (oid === undefined) {
        notFound(ctx);
        return;
      }
      const object = store.getObject(oid);
      sendJson(ctx, 200, { ref: full, object: { sha: oid, type: object?.type ?? 'commit' } });
      return;
    }

    if (restSeg[0] === 'labels' && restSeg.length === 1) {
      if (method === 'GET') {
        const labels = [...repo.labels.values()].sort((a, b) => a.id - b.id);
        paginate(ctx, labels, (label) => labelJson(repo, label.name));
        return;
      }
      if (method === 'POST') {
        const body = bodyOr400(ctx);
        if (body === null) return;
        const name = stringField(body, 'name');
        if (name === undefined || name === '') {
          sendError(ctx, 422, 'Validation Failed: name is required');
          return;
        }
        if (repo.labels.has(name.toLowerCase())) {
          sendJson(ctx, 422, { message: 'Validation Failed: label already exists' });
          return;
        }
        const label = store.createLabel(repo, name, stringField(body, 'color') ?? 'ededed', stringField(body, 'description') ?? null);
        sendJson(ctx, 201, labelJson(repo, label.name));
        return;
      }
      notFound(ctx);
      return;
    }

    if (restSeg[0] === 'issues' && restSeg.length === 1) {
      if (method === 'GET') return listIssues(ctx, repo);
      if (method === 'POST') return createIssue(ctx, repo);
      notFound(ctx);
      return;
    }

    if (restSeg[0] === 'issues' && restSeg.length >= 2) {
      const number = Number.parseInt(restSeg[1] as string, 10);
      const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
      if (restSeg.length === 2) {
        if (issue === undefined) {
          notFound(ctx);
          return;
        }
        if (method === 'GET') {
          sendJson(ctx, 200, issueJson(ctx, repo, issue));
          return;
        }
        if (method === 'PATCH') return patchIssue(ctx, repo, issue);
        notFound(ctx);
        return;
      }
      if (restSeg.length === 3 && restSeg[2] === 'comments') {
        if (issue === undefined) {
          notFound(ctx);
          return;
        }
        if (method === 'GET') {
          const comments = [...issue.comments].sort((a, b) => a.id - b.id);
          paginate(ctx, comments, (comment) => commentJson(ctx, repo, issue, comment.id));
          return;
        }
        if (method === 'POST') {
          const body = bodyOr400(ctx);
          if (body === null) return;
          const text = stringField(body, 'body');
          if (text === undefined) {
            sendError(ctx, 422, 'Validation Failed: body is required');
            return;
          }
          const comment = store.addComment(repo, issue, text);
          sendJson(ctx, 201, commentJson(ctx, repo, issue, comment.id));
          return;
        }
        notFound(ctx);
        return;
      }
      notFound(ctx);
      return;
    }

    if (restSeg[0] === 'pulls' && restSeg.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let items = [...repo.pulls.values()];
        if (state === 'open' || state === 'closed') items = items.filter((pull) => pull.state === state);
        const direction = ctx.query.get('direction') ?? 'desc';
        items.sort((a, b) => (direction === 'asc' ? a.createdAt - b.createdAt || a.number - b.number : b.createdAt - a.createdAt || b.number - a.number));
        paginate(ctx, items, (pull) => pullJson(ctx, repo, pull));
        return;
      }
      if (method === 'POST') return createPull(ctx, repo);
      notFound(ctx);
      return;
    }

    if (restSeg[0] === 'pulls' && restSeg.length >= 2) {
      const number = Number.parseInt(restSeg[1] as string, 10);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) {
        notFound(ctx);
        return;
      }
      if (restSeg.length === 2 && method === 'GET') {
        sendJson(ctx, 200, pullJson(ctx, repo, pull));
        return;
      }
      if (restSeg.length === 3 && restSeg[2] === 'files' && method === 'GET') {
        const baseTip = store.branchTip(repo, pull.baseRef);
        const headTip = store.branchTip(repo, pull.headRef);
        const baseCommit = baseTip === undefined ? undefined : store.peelToCommit(baseTip);
        const headCommit = headTip === undefined ? undefined : store.peelToCommit(headTip);
        if (baseCommit === undefined || headCommit === undefined) {
          sendJson(ctx, 200, []);
          return;
        }
        const headFiles = store.filesOfCommit(headCommit);
        const files = store.diffFiles(repo, baseCommit, headCommit).map((file) => ({
          sha: headFiles.get(file.path)?.oid ?? ZERO_OID,
          filename: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
        }));
        paginate(ctx, files, (file) => file);
        return;
      }
      if (restSeg.length === 3 && restSeg[2] === 'merge' && method === 'PUT') {
        return mergePull(ctx, repo, pull);
      }
      notFound(ctx);
      return;
    }

    notFound(ctx);
    return;
  }

  notFound(ctx);
}
