// mcp.ts — the Model Context Protocol surface at /mcp: JSON-RPC 2.0 with the modern
// server/discover handshake (and the legacy initialize fallback), a deterministic
// tools/list, and tools/call wired to the same store as REST and GraphQL — so an issue
// created over MCP is the same issue REST reads, with the same id.

import { randomUUID } from 'node:crypto';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { VIEWER, type Repo } from './store.ts';
import { sendBytes, sendJson, type WebContext } from './web.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'anvil-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: true };
}

const STRING = { type: 'string' } as const;

/** The tool catalog: names and argument spellings are the canonical ones clients map to. */
export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: objectSchema(
      { name: STRING, description: STRING, private: { type: 'boolean' } },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, name: STRING }, []),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, title: STRING, body: STRING, labels: { type: 'array', items: STRING } },
      ['title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed, all).',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, state: STRING }, []),
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, title: STRING, body: STRING, head: STRING, base: STRING },
      ['title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) by its number.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, pull_number: { type: 'integer' }, merge_method: STRING },
      ['pull_number'],
    ),
  },
];

// ------------------------------------------------------------------ tool execution

interface ToolOutcome {
  payload?: unknown;
  error?: string;
}

/** A minimal context for the REST serializers (they read the store and the host header). */
function serializerContext(ctx: WebContext): WebContext {
  return ctx;
}

function resolveRepo(ctx: WebContext, args: Record<string, unknown>): Repo | undefined {
  const owner = typeof args['owner'] === 'string' ? (args['owner'] as string) : VIEWER.login;
  const name =
    (typeof args['repo'] === 'string' ? (args['repo'] as string) : undefined) ??
    (typeof args['name'] === 'string' ? (args['name'] as string) : undefined);
  if (name === undefined) return undefined;
  return ctx.store.findRepo(owner, name);
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  const required = (tool.inputSchema['required'] as string[] | undefined) ?? [];
  return required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
}

function runTool(ctx: WebContext, name: string, args: Record<string, unknown>): ToolOutcome {
  const store = ctx.store;
  const view = serializerContext(ctx);
  switch (name) {
    case 'create_repo': {
      const repoName = args['name'];
      if (typeof repoName !== 'string' || repoName === '') return { error: 'name is required' };
      if (store.findRepo(VIEWER.login, repoName) !== undefined) return { error: `repository ${repoName} already exists` };
      const repo = store.createRepo(repoName, {
        description: typeof args['description'] === 'string' ? args['description'] : '',
        isPrivate: args['private'] === true,
      });
      return { payload: repoJson(view, repo) };
    }
    case 'get_repo': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return { error: 'repository not found' };
      return { payload: repoJson(view, repo) };
    }
    case 'create_issue': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return { error: 'repository not found' };
      const title = args['title'];
      if (typeof title !== 'string' || title === '') return { error: 'title is required' };
      const labels = Array.isArray(args['labels']) ? args['labels'].map((label) => String(label)) : [];
      const bad = labels.find((label) => !repo.labels.has(label.toLowerCase()));
      if (bad !== undefined) return { error: `label "${bad}" does not exist` };
      const issue = store.createIssue(repo, {
        title,
        body: typeof args['body'] === 'string' ? args['body'] : '',
        labels,
      });
      return { payload: issueJson(view, repo, issue) };
    }
    case 'list_issues': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return { error: 'repository not found' };
      const state = typeof args['state'] === 'string' ? (args['state'] as string) : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return { payload: issues.map((issue) => issueJson(view, repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return { error: 'repository not found' };
      const title = args['title'];
      const head = args['head'];
      const base = args['base'];
      if (typeof title !== 'string' || title === '') return { error: 'title is required' };
      if (typeof head !== 'string' || typeof base !== 'string') return { error: 'head and base are required' };
      if (store.branchTip(repo, head) === undefined || store.branchTip(repo, base) === undefined) {
        return { error: 'head or base branch does not exist' };
      }
      const existing = store.openPullFor(repo, head, base);
      if (existing !== undefined) return { payload: pullJson(view, repo, existing) };
      const pull = store.createPull(repo, {
        title,
        body: typeof args['body'] === 'string' ? args['body'] : '',
        headRef: head,
        baseRef: base,
      });
      return { payload: pullJson(view, repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return { error: 'repository not found' };
      const rawNumber = args['pull_number'] ?? args['number'] ?? args['issue_number'];
      const number = typeof rawNumber === 'number' ? rawNumber : Number.parseInt(String(rawNumber ?? ''), 10);
      if (!Number.isFinite(number)) return { error: 'pull_number is required' };
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { error: `pull request ${number} not found` };
      if (!pull.merged) {
        if (pull.state === 'closed') return { error: 'pull request is closed' };
        const result = store.squashMerge(repo, pull);
        if ('conflict' in result) return { error: 'pull request is not mergeable' };
        if ('missing' in result) return { error: 'pull request branches are missing' };
      }
      return { payload: pullJson(view, repo, pull) };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

// ------------------------------------------------------------------ JSON-RPC plumbing

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
    serverInfo: SERVER_INFO,
    instructions: 'Anvil forge tools: create and read repositories, issues and pull requests.',
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  };
}

function handleMessage(ctx: WebContext, message: RpcMessage): Record<string, unknown> | null {
  const method = typeof message.method === 'string' ? message.method : undefined;
  const id = message.id;
  const isNotification = id === undefined || id === null;
  if (method === undefined) {
    return isNotification ? null : rpcError(id, -32600, 'Invalid Request: method is required');
  }
  if (method.startsWith('notifications/')) return null;
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, discoverResult());
    case 'initialize': {
      const requested = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params['name'] === 'string' ? (params['name'] as string) : '';
      const tool = TOOLS.find((entry) => entry.name === toolName);
      if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      const args = (typeof params['arguments'] === 'object' && params['arguments'] !== null ? params['arguments'] : {}) as Record<string, unknown>;
      const missing = missingArgs(tool, args);
      if (missing.length > 0) {
        return rpcResult(id, { content: [{ type: 'text', text: `Missing required arguments: ${missing.join(', ')}` }], isError: true });
      }
      const outcome = runTool(ctx, toolName, args);
      if (outcome.error !== undefined) {
        return rpcResult(id, { content: [{ type: 'text', text: outcome.error }], isError: true });
      }
      const text = JSON.stringify(outcome.payload ?? {});
      return rpcResult(id, { content: [{ type: 'text', text }], structuredContent: outcome.payload ?? {}, isError: false });
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function handleMcp(ctx: WebContext): void {
  if (ctx.method !== 'POST') {
    sendJson(ctx, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed: use POST' } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    // A non-JSON body is a JSON-RPC parse error, answered with HTTP 400 and code -32700.
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const replies: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      const reply = handleMessage(ctx, (entry ?? {}) as RpcMessage);
      if (reply !== null) replies.push(reply);
    }
    if (replies.length === 0) {
      ctx.res.writeHead(202, { 'x-github-request-id': `anvil-${ctx.requestSeq.toString(16).padStart(8, '0')}` });
      ctx.res.end();
      return;
    }
    sendJson(ctx, 200, replies);
    return;
  }
  const reply = handleMessage(ctx, (parsed ?? {}) as RpcMessage);
  if (reply === null) {
    ctx.res.writeHead(202, { 'x-github-request-id': `anvil-${ctx.requestSeq.toString(16).padStart(8, '0')}` });
    ctx.res.end();
    return;
  }
  if ((parsed as RpcMessage).method === 'initialize') {
    ctx.res.setHeader('mcp-session-id', randomUUID());
  }
  sendBytes(ctx, 200, Buffer.from(JSON.stringify(reply)), 'application/json; charset=utf-8');
}
