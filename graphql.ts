// graphql.ts — the GraphQL v4 surface: a hand-written lexer/parser for the query language
// the suite exercises (operations, variables, aliases, fragments, input objects, enum
// literals), an executor over the same store the REST and git surfaces use, opaque stable
// global ids, and the introspection subset (__type/__schema) the checks enumerate.

import { VIEWER, type Issue, type Pull, type Repo } from './store.ts';
import { sendJson, type WebContext } from './web.ts';

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === 'u' ? String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16)) : esc;
          j += esc === 'u' ? 6 : 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selectionSet?: SelectionNode[];
}
type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition?: string; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  selectionSet: SelectionNode[];
}
interface FragmentNode {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected '${value}'`);
  }
  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('Expected a name');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('Expected a definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ operation: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('Expected on in fragment');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`Unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Array<{ name: string; value: Value }> {
    const args: Array<{ name: string; value: Value }> = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error('Unexpected value');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: Value }> = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }
}

// ------------------------------------------------------------------ global ids

function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':')).toString('base64');
}

function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const parts = raw.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { kind: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

export const repoGid = (repo: Repo): string => gid('Repository', repo.id);
export const issueGid = (repo: Repo, issue: Issue): string => gid('Issue', repo.id, issue.id);
export const pullGid = (repo: Repo, pull: Pull): string => gid('PullRequest', repo.id, pull.id);

// ------------------------------------------------------------------ execution

type Node =
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'User' }
  | { __type: 'Organization' }
  | { __type: 'Label'; repo: Repo; labelName: string }
  | { __type: 'IssueComment'; repo: Repo; issue: Issue; commentId: number }
  | { __type: 'Ref'; repo: Repo; refName: string }
  | { __type: 'Commit'; oid: string }
  | { __type: 'Connection'; connection: ConnectionData }
  | { __type: 'ChangedFile'; path: string; additions: number; deletions: number; changeType: string }
  | { __type: 'Payload'; payload: Record<string, unknown> }
  | { __type: 'TypeInfo'; typeName: string }
  | { __type: 'SchemaInfo' }
  | { __type: 'FieldInfo'; typeName: string; fieldName: string }
  | { __type: 'EnumValueInfo'; name: string }
  | { __type: 'SearchConnection' };

interface ConnectionData {
  /** The connection's GraphQL type name, for __typename. */
  typeName: string;
  items: Node[];
  totalCount: number;
  /** Index of the first item within the full ordered list (for cursors). */
  startIndex: number;
  hasNextPage: boolean;
}

interface ExecCtx {
  store: WebContext['store'];
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

const UNKNOWN = Symbol('unknown-field');

function resolveValue(value: Value, ctx: ExecCtx): unknown {
  switch (value.kind) {
    case 'variable':
      return ctx.variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx);
  return out;
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}

function indexAfter(after: unknown): number {
  if (typeof after !== 'string') return 0;
  try {
    const raw = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(raw);
    return match === null ? 0 : Number.parseInt(match[1] as string, 10) + 1;
  } catch {
    return 0;
  }
}

/** Apply first/after windowing to an ordered item list, connection-style. */
function windowed<T>(items: readonly T[], args: Record<string, unknown>): { slice: T[]; startIndex: number; hasNextPage: boolean } {
  const start = indexAfter(args['after']);
  const first = typeof args['first'] === 'number' ? Math.max(0, Math.floor(args['first'] as number)) : items.length;
  const slice = items.slice(start, start + first);
  return { slice, startIndex: start, hasNextPage: start + slice.length < items.length };
}

function connection(
  typeName: string,
  items: Node[],
  window: { totalCount: number; startIndex: number; hasNextPage: boolean } = { totalCount: items.length, startIndex: 0, hasNextPage: false },
): Node {
  return { __type: 'Connection', connection: { typeName, items, ...window } };
}

function issueNode(repo: Repo, issue: Issue): Node {
  return { __type: 'Issue', repo, issue };
}
function pullNode(repo: Repo, pull: Pull): Node {
  return { __type: 'PullRequest', repo, pull };
}

// Ordering + filtering shared by the issue/pull connections.
function orderItems<T extends { createdAt: number; number: number }>(items: T[], args: Record<string, unknown>): T[] {
  const orderBy = (args['orderBy'] ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction ?? 'ASC';
  const sorted = [...items];
  sorted.sort((a, b) => (direction === 'DESC' ? b.createdAt - a.createdAt || b.number - a.number : a.createdAt - b.createdAt || a.number - b.number));
  return sorted;
}

function stateFilter<T extends { state: string }>(items: T[], args: Record<string, unknown>, merged?: (item: T) => string): T[] {
  const states = args['states'];
  if (!Array.isArray(states) || states.length === 0) return items;
  const wanted = new Set(states.map((state) => String(state).toUpperCase()));
  return items.filter((item) => wanted.has(merged !== undefined ? merged(item) : item.state.toUpperCase()));
}

// ------------------------------------------------------------------ schema tables

const TYPE_FIELDS: Record<string, Record<string, string>> = {
  Query: {
    repository: 'Repository',
    viewer: 'User',
    user: 'User',
    organization: 'Organization',
    node: 'Node',
    search: 'SearchResultItemConnection',
    rateLimit: 'RateLimit',
    __type: '__Type',
    __schema: '__Schema',
  },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
    __type: '__Type',
    __schema: '__Schema',
  },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    description: 'String',
    isPrivate: 'Boolean',
    createdAt: 'DateTime',
    updatedAt: 'DateTime',
    url: 'URI',
    viewerPermission: 'RepositoryPermission',
    hasIssuesEnabled: 'Boolean',
    hasProjectsEnabled: 'Boolean',
    hasWikiEnabled: 'Boolean',
    isEmpty: 'Boolean',
    isFork: 'Boolean',
    defaultBranchRef: 'Ref',
    owner: 'RepositoryOwner',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequest: 'PullRequest',
    pullRequests: 'PullRequestConnection',
    label: 'Label',
    labels: 'LabelConnection',
    object: 'GitObject',
    stargazerCount: 'Int',
    forkCount: 'Int',
    __typename: 'String',
  },
  Issue: {
    id: 'ID',
    databaseId: 'Int',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'IssueState',
    closed: 'Boolean',
    createdAt: 'DateTime',
    updatedAt: 'DateTime',
    closedAt: 'DateTime',
    url: 'URI',
    repository: 'Repository',
    author: 'Actor',
    labels: 'LabelConnection',
    comments: 'IssueCommentConnection',
    __typename: 'String',
  },
  PullRequest: {
    id: 'ID',
    databaseId: 'Int',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'PullRequestState',
    merged: 'Boolean',
    mergedAt: 'DateTime',
    closedAt: 'DateTime',
    createdAt: 'DateTime',
    updatedAt: 'DateTime',
    headRefName: 'String',
    baseRefName: 'String',
    headRefOid: 'GitObjectID',
    baseRefOid: 'GitObjectID',
    mergeable: 'MergeableState',
    mergeCommit: 'Commit',
    url: 'URI',
    repository: 'Repository',
    author: 'Actor',
    files: 'PullRequestChangedFileConnection',
    additions: 'Int',
    deletions: 'Int',
    changedFiles: 'Int',
    __typename: 'String',
  },
  User: { id: 'ID', login: 'String', name: 'String', email: 'String', url: 'URI', databaseId: 'Int', __typename: 'String' },
  Organization: { id: 'ID', login: 'String', name: 'String', url: 'URI', __typename: 'String' },
  Label: { id: 'ID', name: 'String', color: 'String', description: 'String', __typename: 'String' },
  IssueComment: { id: 'ID', databaseId: 'Int', body: 'String', createdAt: 'DateTime', updatedAt: 'DateTime', author: 'Actor', url: 'URI', issue: 'Issue', __typename: 'String' },
  Ref: { name: 'String', prefix: 'String', target: 'GitObject', __typename: 'String' },
  Commit: { id: 'ID', oid: 'GitObjectID', tree: 'Tree', __typename: 'String' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'PatchStatus', __typename: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String', __typename: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String', __typename: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String', __typename: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String', __typename: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String', __typename: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Node', clientMutationId: 'String', __typename: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String', __typename: 'String' },
  SearchResultItemConnection: { issueCount: 'Int', repositoryCount: 'Int', userCount: 'Int', edges: 'SearchResultItemEdge', nodes: 'SearchResultItem', pageInfo: 'PageInfo', __typename: 'String' },
  RateLimit: { limit: 'Int', cost: 'Int', remaining: 'Int', used: 'Int', resetAt: 'DateTime', nodeCount: 'Int', __typename: 'String' },
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'ISSUE_ADVANCED'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PatchStatus: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const ALL_TYPE_NAMES = [
  ...Object.keys(TYPE_FIELDS),
  'IssueConnection',
  'PullRequestConnection',
  'LabelConnection',
  'IssueCommentConnection',
  'PullRequestChangedFileConnection',
  'SearchResultItemEdge',
  '__Type',
  '__Schema',
  '__Field',
  '__EnumValue',
  'Node',
  'Actor',
  'RepositoryOwner',
  'GitObject',
  'Tree',
  'DateTime',
  'URI',
  'GitObjectID',
  'ID',
  'String',
  'Int',
  'Float',
  'Boolean',
  ...Object.keys(ENUM_VALUES),
];

// ------------------------------------------------------------------ field resolution

function findRepoByGid(store: ExecCtx['store'], id: unknown): Repo | undefined {
  if (typeof id !== 'string') return undefined;
  const parsed = parseGid(id);
  if (parsed === null || parsed.kind !== 'Repository') return undefined;
  return store.reposById.get(Number.parseInt(parsed.parts[0] as string, 10));
}

function findIssueByGid(store: ExecCtx['store'], id: unknown): { repo: Repo; issue: Issue } | undefined {
  if (typeof id !== 'string') return undefined;
  const parsed = parseGid(id);
  if (parsed === null) return undefined;
  if (parsed.kind === 'Issue') {
    const repo = store.reposById.get(Number.parseInt(parsed.parts[0] as string, 10));
    const issueId = Number.parseInt(parsed.parts[1] as string, 10);
    const issue = repo === undefined ? undefined : [...repo.issues.values()].find((entry) => entry.id === issueId);
    return repo !== undefined && issue !== undefined ? { repo, issue } : undefined;
  }
  return undefined;
}

function findPullByGid(store: ExecCtx['store'], id: unknown): { repo: Repo; pull: Pull } | undefined {
  if (typeof id !== 'string') return undefined;
  const parsed = parseGid(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return undefined;
  const repo = store.reposById.get(Number.parseInt(parsed.parts[0] as string, 10));
  const pullId = Number.parseInt(parsed.parts[1] as string, 10);
  const pull = repo === undefined ? undefined : [...repo.pulls.values()].find((entry) => entry.id === pullId);
  return repo !== undefined && pull !== undefined ? { repo, pull } : undefined;
}

function nodeByGid(store: ExecCtx['store'], id: unknown): Node | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGid(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = store.reposById.get(Number.parseInt(parsed.parts[0] as string, 10));
    return repo === undefined ? null : { __type: 'Repository', repo };
  }
  const issueHit = findIssueByGid(store, id);
  if (issueHit !== undefined) return issueNode(issueHit.repo, issueHit.issue);
  const pullHit = findPullByGid(store, id);
  if (pullHit !== undefined) return pullNode(pullHit.repo, pullHit.pull);
  if (parsed.kind === 'IssueComment') {
    const hit = store.commentsById.get(Number.parseInt(parsed.parts[0] as string, 10));
    return hit === undefined ? null : { __type: 'IssueComment', repo: hit.repo, issue: hit.issue, commentId: hit.comment.id };
  }
  if (parsed.kind === 'User') return { __type: 'User' };
  if (parsed.kind === 'Label') {
    const repo = store.reposById.get(Number.parseInt(parsed.parts[0] as string, 10));
    const labelId = Number.parseInt(parsed.parts[1] as string, 10);
    const label = repo === undefined ? undefined : [...repo.labels.values()].find((entry) => entry.id === labelId);
    return repo !== undefined && label !== undefined ? { __type: 'Label', repo, labelName: label.name } : null;
  }
  return null;
}

type Resolver = (source: Node | null, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    repository: (_source, args, ctx) => {
      const repo = ctx.store.findRepo(String(args['owner'] ?? ''), String(args['name'] ?? ''));
      return repo === undefined ? null : ({ __type: 'Repository', repo } satisfies Node);
    },
    viewer: () => ({ __type: 'User' }) as Node,
    user: (_source, args) => (args['login'] === VIEWER.login ? (({ __type: 'User' }) as Node) : null),
    organization: (_source, args) => (typeof args['login'] === 'string' ? (({ __type: 'Organization' }) as Node) : null),
    node: (_source, args, ctx) => nodeByGid(ctx.store, args['id']),
    search: () => ({ __type: 'SearchConnection' }) as Node,
    rateLimit: () => ({ __type: 'Payload', payload: { __payloadType: 'RateLimit', limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: null, nodeCount: 0 } }) as Node,
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const repo = findRepoByGid(ctx.store, input['repositoryId']);
      if (repo === undefined) return { __type: 'Payload', payload: { __payloadType: 'CreateIssuePayload', issue: null, clientMutationId: input['clientMutationId'] ?? null } } as Node;
      const issue = ctx.store.createIssue(repo, {
        title: String(input['title'] ?? ''),
        body: typeof input['body'] === 'string' ? input['body'] : '',
        labels: [],
      });
      return { __type: 'Payload', payload: { __payloadType: 'CreateIssuePayload', issue: issueNode(repo, issue), clientMutationId: input['clientMutationId'] ?? null } } as Node;
    },
    closeIssue: (_source, args, ctx) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const hit = findIssueByGid(ctx.store, input['issueId']);
      if (hit === undefined) return { __type: 'Payload', payload: { __payloadType: 'CloseIssuePayload', issue: null, clientMutationId: input['clientMutationId'] ?? null } } as Node;
      hit.issue.state = 'closed';
      hit.issue.closedAt = ctx.store.now();
      hit.issue.updatedAt = ctx.store.now();
      return { __type: 'Payload', payload: { __payloadType: 'CloseIssuePayload', issue: issueNode(hit.repo, hit.issue), clientMutationId: input['clientMutationId'] ?? null } } as Node;
    },
    createPullRequest: (_source, args, ctx) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const repo = findRepoByGid(ctx.store, input['repositoryId']);
      if (repo === undefined) return { __type: 'Payload', payload: { __payloadType: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: input['clientMutationId'] ?? null } } as Node;
      const pull = ctx.store.createPull(repo, {
        title: String(input['title'] ?? ''),
        body: typeof input['body'] === 'string' ? input['body'] : '',
        headRef: String(input['headRefName'] ?? ''),
        baseRef: String(input['baseRefName'] ?? ''),
      });
      return { __type: 'Payload', payload: { __payloadType: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull), clientMutationId: input['clientMutationId'] ?? null } } as Node;
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const hit = findPullByGid(ctx.store, input['pullRequestId']);
      if (hit === undefined) return { __type: 'Payload', payload: { __payloadType: 'MergePullRequestPayload', pullRequest: null, clientMutationId: input['clientMutationId'] ?? null } } as Node;
      if (!hit.pull.merged && hit.pull.state === 'open') ctx.store.squashMerge(hit.repo, hit.pull);
      return { __type: 'Payload', payload: { __payloadType: 'MergePullRequestPayload', pullRequest: pullNode(hit.repo, hit.pull), clientMutationId: input['clientMutationId'] ?? null } } as Node;
    },
    addComment: (_source, args, ctx) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const hit = findIssueByGid(ctx.store, input['subjectId']);
      if (hit === undefined) return { __type: 'Payload', payload: { __payloadType: 'AddCommentPayload', commentEdge: null, subject: null, clientMutationId: input['clientMutationId'] ?? null } } as Node;
      const comment = ctx.store.addComment(hit.repo, hit.issue, String(input['body'] ?? ''));
      const commentNode: Node = { __type: 'IssueComment', repo: hit.repo, issue: hit.issue, commentId: comment.id };
      const edge: Node = { __type: 'Payload', payload: { __payloadType: 'IssueCommentEdge', node: commentNode, cursor: cursorOf(hit.issue.comments.length - 1) } };
      return { __type: 'Payload', payload: { __payloadType: 'AddCommentPayload', commentEdge: edge, subject: issueNode(hit.repo, hit.issue), clientMutationId: input['clientMutationId'] ?? null } } as Node;
    },
  },
  Repository: {
    id: (source) => repoGid((source as { repo: Repo }).repo),
    databaseId: (source) => (source as { repo: Repo }).repo.id,
    name: (source) => (source as { repo: Repo }).repo.name,
    nameWithOwner: (source) => {
      const repo = (source as { repo: Repo }).repo;
      return `${repo.owner}/${repo.name}`;
    },
    description: (source) => (source as { repo: Repo }).repo.description,
    isPrivate: (source) => (source as { repo: Repo }).repo.isPrivate,
    createdAt: (source, _args, ctx) => ctx.store.iso((source as { repo: Repo }).repo.createdAt),
    updatedAt: (source, _args, ctx) => ctx.store.iso((source as { repo: Repo }).repo.updatedAt),
    url: (source) => `https://github.invalid/${(source as { repo: Repo }).repo.owner}/${(source as { repo: Repo }).repo.name}`,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasProjectsEnabled: () => false,
    hasWikiEnabled: () => false,
    isEmpty: (source, _args, ctx) => ctx.store.branchTip((source as { repo: Repo }).repo, (source as { repo: Repo }).repo.defaultBranch) === undefined,
    isFork: () => false,
    defaultBranchRef: (source, _args, ctx) => {
      const repo = (source as { repo: Repo }).repo;
      return ctx.store.branchTip(repo, repo.defaultBranch) === undefined ? null : (({ __type: 'Ref', repo, refName: repo.defaultBranch }) as Node);
    },
    owner: (source) => {
      const repo = (source as { repo: Repo }).repo;
      return (repo.owner === VIEWER.login ? { __type: 'User' } : { __type: 'Organization' }) as Node;
    },
    issue: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const issue = repo.issues.get(Number(args['number']));
      return issue === undefined ? null : issueNode(repo, issue);
    },
    issues: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const filtered = stateFilter([...repo.issues.values()], args);
      const ordered = orderItems(filtered, args);
      const win = windowed(ordered, args);
      return connection('IssueConnection', win.slice.map((issue) => issueNode(repo, issue)), { totalCount: ordered.length, startIndex: win.startIndex, hasNextPage: win.hasNextPage });
    },
    pullRequest: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const pull = repo.pulls.get(Number(args['number']));
      return pull === undefined ? null : pullNode(repo, pull);
    },
    pullRequests: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const filtered = stateFilter([...repo.pulls.values()], args, (pull) => (pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      const ordered = orderItems(filtered, args);
      const win = windowed(ordered, args);
      return connection('PullRequestConnection', win.slice.map((pull) => pullNode(repo, pull)), { totalCount: ordered.length, startIndex: win.startIndex, hasNextPage: win.hasNextPage });
    },
    label: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const label = repo.labels.get(String(args['name'] ?? '').toLowerCase());
      return label === undefined ? null : (({ __type: 'Label', repo, labelName: label.name }) as Node);
    },
    labels: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const all = [...repo.labels.values()].sort((a, b) => a.id - b.id);
      const win = windowed(all, args);
      return connection('LabelConnection', win.slice.map((label) => ({ __type: 'Label', repo, labelName: label.name }) as Node), { totalCount: all.length, startIndex: win.startIndex, hasNextPage: win.hasNextPage });
    },
    object: (source, args, ctx) => {
      const repo = (source as { repo: Repo }).repo;
      const expression = String(args['expression'] ?? '');
      const tip = ctx.store.branchTip(repo, expression === '' ? repo.defaultBranch : expression);
      const commit = tip === undefined ? undefined : ctx.store.peelToCommit(tip);
      return commit === undefined ? null : (({ __type: 'Commit', oid: commit }) as Node);
    },
    stargazerCount: () => 0,
    forkCount: () => 0,
  },
  Issue: {
    id: (source) => issueGid((source as { repo: Repo }).repo, (source as { issue: Issue }).issue),
    databaseId: (source) => (source as { issue: Issue }).issue.id,
    number: (source) => (source as { issue: Issue }).issue.number,
    title: (source) => (source as { issue: Issue }).issue.title,
    body: (source) => (source as { issue: Issue }).issue.body,
    state: (source) => ((source as { issue: Issue }).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    closed: (source) => (source as { issue: Issue }).issue.state === 'closed',
    createdAt: (source, _args, ctx) => ctx.store.iso((source as { issue: Issue }).issue.createdAt),
    updatedAt: (source, _args, ctx) => ctx.store.iso((source as { issue: Issue }).issue.updatedAt),
    closedAt: (source, _args, ctx) => {
      const issue = (source as { issue: Issue }).issue;
      return issue.closedAt === null ? null : ctx.store.iso(issue.closedAt);
    },
    url: (source) => {
      const entry = source as { repo: Repo; issue: Issue };
      return `https://github.invalid/${entry.repo.owner}/${entry.repo.name}/issues/${entry.issue.number}`;
    },
    repository: (source) => ({ __type: 'Repository', repo: (source as { repo: Repo }).repo }) as Node,
    author: () => ({ __type: 'User' }) as Node,
    labels: (source, args) => {
      const entry = source as { repo: Repo; issue: Issue };
      const nodes: Node[] = entry.issue.labels
        .map((name) => entry.repo.labels.get(name.toLowerCase()))
        .filter((label) => label !== undefined)
        .map((label) => ({ __type: 'Label', repo: entry.repo, labelName: (label as { name: string }).name }) as Node);
      const win = windowed(nodes, args);
      return connection('LabelConnection', win.slice, { totalCount: nodes.length, startIndex: win.startIndex, hasNextPage: win.hasNextPage });
    },
    comments: (source, args) => {
      const entry = source as { repo: Repo; issue: Issue };
      const ordered = [...entry.issue.comments].sort((a, b) => a.id - b.id);
      const win = windowed(ordered, args);
      return connection(
        'IssueCommentConnection',
        win.slice.map((comment) => ({ __type: 'IssueComment', repo: entry.repo, issue: entry.issue, commentId: comment.id }) as Node),
        { totalCount: ordered.length, startIndex: win.startIndex, hasNextPage: win.hasNextPage },
      );
    },
  },
  PullRequest: {
    id: (source) => pullGid((source as { repo: Repo }).repo, (source as { pull: Pull }).pull),
    databaseId: (source) => (source as { pull: Pull }).pull.id,
    number: (source) => (source as { pull: Pull }).pull.number,
    title: (source) => (source as { pull: Pull }).pull.title,
    body: (source) => (source as { pull: Pull }).pull.body,
    state: (source) => {
      const pull = (source as { pull: Pull }).pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (source) => (source as { pull: Pull }).pull.merged,
    mergedAt: (source, _args, ctx) => {
      const pull = (source as { pull: Pull }).pull;
      return pull.mergedAt === null ? null : ctx.store.iso(pull.mergedAt);
    },
    closedAt: (source, _args, ctx) => {
      const pull = (source as { pull: Pull }).pull;
      return pull.closedAt === null ? null : ctx.store.iso(pull.closedAt);
    },
    createdAt: (source, _args, ctx) => ctx.store.iso((source as { pull: Pull }).pull.createdAt),
    updatedAt: (source, _args, ctx) => ctx.store.iso((source as { pull: Pull }).pull.updatedAt),
    headRefName: (source) => (source as { pull: Pull }).pull.headRef,
    baseRefName: (source) => (source as { pull: Pull }).pull.baseRef,
    headRefOid: (source, _args, ctx) => {
      const entry = source as { repo: Repo; pull: Pull };
      return ctx.store.branchTip(entry.repo, entry.pull.headRef) ?? null;
    },
    baseRefOid: (source, _args, ctx) => {
      const entry = source as { repo: Repo; pull: Pull };
      return ctx.store.branchTip(entry.repo, entry.pull.baseRef) ?? null;
    },
    mergeable: (source, _args, ctx) => {
      const entry = source as { repo: Repo; pull: Pull };
      if (entry.pull.state !== 'open') return 'UNKNOWN';
      const plan = ctx.store.pullMergePlan(entry.repo, entry.pull);
      return plan.ok ? 'MERGEABLE' : 'CONFLICTING';
    },
    mergeCommit: (source) => {
      const pull = (source as { pull: Pull }).pull;
      return pull.mergeCommitSha === null ? null : (({ __type: 'Commit', oid: pull.mergeCommitSha }) as Node);
    },
    url: (source) => {
      const entry = source as { repo: Repo; pull: Pull };
      return `https://github.invalid/${entry.repo.owner}/${entry.repo.name}/pull/${entry.pull.number}`;
    },
    repository: (source) => ({ __type: 'Repository', repo: (source as { repo: Repo }).repo }) as Node,
    author: () => ({ __type: 'User' }) as Node,
    files: (source, args, ctx) => {
      const entry = source as { repo: Repo; pull: Pull };
      const baseTip = ctx.store.branchTip(entry.repo, entry.pull.baseRef);
      const headTip = ctx.store.branchTip(entry.repo, entry.pull.headRef);
      const baseCommit = baseTip === undefined ? undefined : ctx.store.peelToCommit(baseTip);
      const headCommit = headTip === undefined ? undefined : ctx.store.peelToCommit(headTip);
      if (baseCommit === undefined || headCommit === undefined) return connection('PullRequestChangedFileConnection', []);
      const diffs = ctx.store.diffFiles(entry.repo, baseCommit, headCommit);
      const nodes: Node[] = diffs.map((file) => ({
        __type: 'ChangedFile',
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }));
      const win = windowed(nodes, args);
      return connection('PullRequestChangedFileConnection', win.slice, { totalCount: nodes.length, startIndex: win.startIndex, hasNextPage: win.hasNextPage });
    },
    additions: (source, _args, ctx) => pullDiffTotals(source as { repo: Repo; pull: Pull }, ctx).additions,
    deletions: (source, _args, ctx) => pullDiffTotals(source as { repo: Repo; pull: Pull }, ctx).deletions,
    changedFiles: (source, _args, ctx) => pullDiffTotals(source as { repo: Repo; pull: Pull }, ctx).count,
  },
  User: {
    id: () => gid('User', VIEWER.id),
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    url: () => `https://github.invalid/${VIEWER.login}`,
    databaseId: () => VIEWER.id,
  },
  Organization: {
    id: () => gid('Organization', 1),
    login: () => 'faint-meadow-org',
    name: () => 'faint-meadow-org',
    url: () => 'https://github.invalid/orgs/faint-meadow-org',
  },
  Label: {
    id: (source) => {
      const entry = source as { repo: Repo; labelName: string };
      const label = entry.repo.labels.get(entry.labelName.toLowerCase());
      return gid('Label', entry.repo.id, label?.id ?? 0);
    },
    name: (source) => (source as { labelName: string }).labelName,
    color: (source) => {
      const entry = source as { repo: Repo; labelName: string };
      return entry.repo.labels.get(entry.labelName.toLowerCase())?.color ?? 'ededed';
    },
    description: (source) => {
      const entry = source as { repo: Repo; labelName: string };
      return entry.repo.labels.get(entry.labelName.toLowerCase())?.description ?? null;
    },
  },
  IssueComment: {
    id: (source) => gid('IssueComment', (source as { commentId: number }).commentId),
    databaseId: (source) => (source as { commentId: number }).commentId,
    body: (source, _args, ctx) => commentOf(source as { commentId: number }, ctx)?.body ?? '',
    createdAt: (source, _args, ctx) => {
      const comment = commentOf(source as { commentId: number }, ctx);
      return comment === undefined ? null : ctx.store.iso(comment.createdAt);
    },
    updatedAt: (source, _args, ctx) => {
      const comment = commentOf(source as { commentId: number }, ctx);
      return comment === undefined ? null : ctx.store.iso(comment.updatedAt);
    },
    author: () => ({ __type: 'User' }) as Node,
    url: (source) => {
      const entry = source as { repo: Repo; issue: Issue; commentId: number };
      return `https://github.invalid/${entry.repo.owner}/${entry.repo.name}/issues/${entry.issue.number}#issuecomment-${entry.commentId}`;
    },
    issue: (source) => issueNode((source as { repo: Repo }).repo, (source as { issue: Issue }).issue),
  },
  Ref: {
    name: (source) => (source as { refName: string }).refName,
    prefix: () => 'refs/heads/',
    target: (source, _args, ctx) => {
      const entry = source as { repo: Repo; refName: string };
      const tip = ctx.store.branchTip(entry.repo, entry.refName);
      const commit = tip === undefined ? undefined : ctx.store.peelToCommit(tip);
      return commit === undefined ? null : (({ __type: 'Commit', oid: commit }) as Node);
    },
  },
  Commit: {
    id: (source) => gid('Commit', (source as { oid: string }).oid),
    oid: (source) => (source as { oid: string }).oid,
    tree: (source, _args, ctx) => {
      const view = ctx.store.commitView((source as { oid: string }).oid);
      return view === undefined ? null : (({ __type: 'Commit', oid: view.tree }) as Node);
    },
  },
  PullRequestChangedFile: {
    path: (source) => (source as { path: string }).path,
    additions: (source) => (source as { additions: number }).additions,
    deletions: (source) => (source as { deletions: number }).deletions,
    changeType: (source) => (source as { changeType: string }).changeType,
  },
};

function commentOf(source: { commentId: number }, ctx: ExecCtx): { body: string; createdAt: number; updatedAt: number } | undefined {
  return ctx.store.commentsById.get(source.commentId)?.comment;
}

function pullDiffTotals(entry: { repo: Repo; pull: Pull }, ctx: ExecCtx): { additions: number; deletions: number; count: number } {
  const baseTip = ctx.store.branchTip(entry.repo, entry.pull.baseRef);
  const headTip = ctx.store.branchTip(entry.repo, entry.pull.headRef);
  const baseCommit = baseTip === undefined ? undefined : ctx.store.peelToCommit(baseTip);
  const headCommit = headTip === undefined ? undefined : ctx.store.peelToCommit(headTip);
  if (baseCommit === undefined || headCommit === undefined) return { additions: 0, deletions: 0, count: 0 };
  const diffs = ctx.store.diffFiles(entry.repo, baseCommit, headCommit);
  return {
    additions: diffs.reduce((sum, file) => sum + file.additions, 0),
    deletions: diffs.reduce((sum, file) => sum + file.deletions, 0),
    count: diffs.length,
  };
}

// ------------------------------------------------------------------ executor

function typeNameOf(node: Node): string {
  if (node.__type === 'Connection') return node.connection.typeName;
  if (node.__type === 'Payload') return String(node.payload['__payloadType'] ?? 'Payload');
  if (node.__type === 'ChangedFile') return 'PullRequestChangedFile';
  if (node.__type === 'SearchConnection') return 'SearchResultItemConnection';
  return node.__type;
}

function expandSelections(selections: SelectionNode[], typeName: string, ctx: ExecCtx): FieldNode[] {
  const fields: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.kind === 'field') fields.push(selection);
    else if (selection.kind === 'inline') {
      if (selection.typeCondition === undefined || selection.typeCondition === typeName) {
        fields.push(...expandSelections(selection.selectionSet, typeName, ctx));
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === typeName) {
        fields.push(...expandSelections(fragment.selectionSet, typeName, ctx));
      }
    }
  }
  return fields;
}

function executeSelectionSet(typeName: string, source: Node | null, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of expandSelections(selections, typeName, ctx)) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (field.name === '__type' && (typeName === 'Query' || typeName === 'Mutation')) {
      const args = argsOf(field, ctx);
      const name = String(args['name'] ?? '');
      const typeNode: Node = { __type: 'TypeInfo', typeName: name };
      out[key] = field.selectionSet === undefined ? null : executeSelectionSet('__Type', typeNode, field.selectionSet, ctx);
      continue;
    }
    if (field.name === '__schema' && (typeName === 'Query' || typeName === 'Mutation')) {
      const schemaNode: Node = { __type: 'SchemaInfo' };
      out[key] = field.selectionSet === undefined ? null : executeSelectionSet('__Schema', schemaNode, field.selectionSet, ctx);
      continue;
    }
    const value = resolveField(typeName, source, field, ctx);
    if (value === UNKNOWN) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, field, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, field, ctx));
  if (typeof value === 'object' && (value as Node).__type !== undefined) {
    const node = value as Node;
    if (field.selectionSet === undefined) return null;
    return executeSelectionSet(typeNameOf(node), node, field.selectionSet, ctx);
  }
  return value;
}

function resolveField(typeName: string, source: Node | null, field: FieldNode, ctx: ExecCtx): unknown {
  const args = argsOf(field, ctx);
  // Connection pseudo-fields (nodes/edges/pageInfo/totalCount) are served structurally.
  if (source !== null && source.__type === 'Connection') return connectionField(source.connection, field, ctx);
  if (source !== null && source.__type === 'SearchConnection') return searchField(field, ctx);
  if (source !== null && source.__type === 'TypeInfo') return typeInfoField(source.typeName, field, ctx);
  if (source !== null && source.__type === 'SchemaInfo') return schemaField(field, ctx);
  if (source !== null && source.__type === 'FieldInfo') return fieldInfoField(source, field);
  if (source !== null && source.__type === 'EnumValueInfo') return field.name === 'name' ? source.name : UNKNOWN;
  if (source !== null && source.__type === 'Payload') {
    const payload = source.payload;
    if (field.name in payload) return payload[field.name];
    return UNKNOWN;
  }
  const typeResolvers = RESOLVERS[typeName];
  const resolver = typeResolvers?.[field.name];
  if (resolver === undefined) return UNKNOWN;
  return resolver(source, args, ctx);
}

function connectionField(connectionData: ConnectionData, field: FieldNode, ctx: ExecCtx): unknown {
  const items = connectionData.items;
  if (field.name === 'totalCount') return connectionData.totalCount;
  if (field.name === 'nodes') return items;
  if (field.name === 'edges') {
    return items.map((node, index) => ({
      __type: 'Payload',
      payload: { __payloadType: 'Edge', node, cursor: cursorOf(connectionData.startIndex + index) },
    }) as Node);
  }
  if (field.name === 'pageInfo') {
    return {
      __type: 'Payload',
      payload: {
        __payloadType: 'PageInfo',
        hasNextPage: connectionData.hasNextPage,
        hasPreviousPage: connectionData.startIndex > 0,
        startCursor: items.length > 0 ? cursorOf(connectionData.startIndex) : null,
        endCursor: items.length > 0 ? cursorOf(connectionData.startIndex + items.length - 1) : null,
      },
    } as Node;
  }
  return UNKNOWN;
}

function searchField(field: FieldNode, _ctx: ExecCtx): unknown {
  switch (field.name) {
    case 'issueCount':
    case 'repositoryCount':
    case 'userCount':
      return 0;
    case 'edges':
    case 'nodes':
      return [];
    case 'pageInfo':
      return {
        __type: 'Payload',
        payload: { __payloadType: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      } as Node;
    default:
      return UNKNOWN;
  }
}

function typeInfoField(typeName: string, field: FieldNode, ctx: ExecCtx): unknown {
  const fields = TYPE_FIELDS[typeName];
  const enumValues = ENUM_VALUES[typeName];
  switch (field.name) {
    case 'name':
      return typeName === '' ? null : typeName;
    case 'kind':
      if (enumValues !== undefined) return 'ENUM';
      if (typeName === 'ID' || typeName === 'String' || typeName === 'Int' || typeName === 'Float' || typeName === 'Boolean' || typeName === 'DateTime' || typeName === 'URI' || typeName === 'GitObjectID') return 'SCALAR';
      if (typeName === 'Node' || typeName === 'Actor' || typeName === 'RepositoryOwner') return 'INTERFACE';
      return 'OBJECT';
    case 'fields': {
      if (fields === undefined) return null;
      return Object.keys(fields)
        .filter((name) => name !== '__typename')
        .map((name) => ({ __type: 'FieldInfo', typeName, fieldName: name }) as Node);
    }
    case 'enumValues':
      return enumValues === undefined ? null : enumValues.map((name) => ({ __type: 'EnumValueInfo', name }) as Node);
    case 'possibleTypes':
      return null;
    case 'inputFields':
      return null;
    case 'ofType':
      return null;
    case 'description':
      return null;
    default:
      void ctx;
      return UNKNOWN;
  }
}

function fieldInfoField(source: { typeName: string; fieldName: string }, field: FieldNode): unknown {
  switch (field.name) {
    case 'name':
      return source.fieldName;
    case 'type': {
      const typeName = TYPE_FIELDS[source.typeName]?.[source.fieldName] ?? 'String';
      return { __type: 'TypeInfo', typeName } as Node;
    }
    case 'args':
      return [];
    case 'description':
      return null;
    case 'isDeprecated':
      return false;
    case 'deprecationReason':
      return null;
    default:
      return UNKNOWN;
  }
}

function schemaField(field: FieldNode, _ctx: ExecCtx): unknown {
  switch (field.name) {
    case 'types':
      return ALL_TYPE_NAMES.map((name) => ({ __type: 'TypeInfo', typeName: name }) as Node);
    case 'queryType':
      return { __type: 'TypeInfo', typeName: 'Query' } as Node;
    case 'mutationType':
      return { __type: 'TypeInfo', typeName: 'Mutation' } as Node;
    case 'subscriptionType':
      return null;
    case 'directives':
      return [];
    default:
      return UNKNOWN;
  }
}

// ------------------------------------------------------------------ HTTP entry

interface OperationRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function executeOperation(store: WebContext['store'], request: OperationRequest): Record<string, unknown> {
  let document: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    document = new Parser(lex(request.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
  }
  const operation =
    document.operations.find((entry) => request.operationName !== undefined && entry.name === request.operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
  const ctx: ExecCtx = {
    store,
    variables: request.variables ?? {},
    fragments: document.fragments,
    errors: [],
  };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, null, operation.selectionSet, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result['errors'] = ctx.errors;
  return result;
}

export function handleGraphql(ctx: WebContext): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeOperation(ctx.store, entry as OperationRequest));
    sendJson(ctx, 200, results);
    return;
  }
  const result = executeOperation(ctx.store, parsed as OperationRequest);
  sendJson(ctx, 200, result);
}
