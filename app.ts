// app.ts — Anvil's HTTP front door: it reads each request whole, enforces the bearer-token
// rule (the health check is the one open door), and routes to the four surfaces — REST v3,
// GraphQL, MCP, and git smart HTTP — sharing one store. Anything unrouted is a JSON 404,
// and an unexpected failure is a JSON 500, never a crashed process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import type { Store } from './store.ts';
import { sendError, sendJson, type WebContext } from './web.ts';

export interface ForgeOptions {
  /** The bearer token requests must carry; when unset, no auth is enforced. */
  token?: string;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createForgeServer(store: Store, options: ForgeOptions): Server {
  let requestSeq = 0;
  const expectedAuth = options.token === undefined || options.token === '' ? null : `Bearer ${options.token}`;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      requestSeq += 1;
      const url = new URL(req.url ?? '/', 'http://anvil.invalid');
      const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
      const ctx: WebContext = {
        store,
        req,
        res,
        method: (req.method ?? 'GET').toUpperCase(),
        pathname: url.pathname,
        segments,
        query: url.searchParams,
        body: Buffer.alloc(0),
        authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
        requestSeq,
      };
      try {
        // The health check is unauthenticated and bodyless by contract.
        if (url.pathname === '/healthz' && ctx.method === 'GET') {
          sendJson(ctx, 200, { ok: true });
          return;
        }
        ctx.body = await readBody(req);
        if (expectedAuth !== null && ctx.authorization !== expectedAuth) {
          sendJson(ctx, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
          return;
        }
        if (segments[0] === 'api' && segments[1] === 'v3') {
          handleRest(ctx);
          return;
        }
        if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
          if (ctx.method !== 'POST') {
            sendError(ctx, 404, 'Not Found');
            return;
          }
          handleGraphql(ctx);
          return;
        }
        if (segments[0] === 'mcp' && segments.length === 1) {
          handleMcp(ctx);
          return;
        }
        if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -'.git'.length);
          const rest = `/${segments.slice(2).join('/')}`;
          handleGit(ctx, owner, repoName, rest);
          return;
        }
        sendError(ctx, 404, 'Not Found');
      } catch (err) {
        console.error('anvil: request failed', err);
        if (!res.headersSent) sendError(ctx, 500, 'Internal Server Error');
        else res.end();
      }
    })();
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  return server;
}

/** Bind the forge on an ephemeral port and report the chosen port. */
export function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server has no port'));
        return;
      }
      resolve(address.port);
    });
  });
}
