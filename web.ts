// web.ts — the small HTTP toolkit every surface shares: the parsed-request context the
// router hands to a surface module, JSON replies with the GitHub request-id discipline,
// and error bodies of the {message} shape the suite's protocol checks require.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export interface WebContext {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** The decoded URL pathname, e.g. /api/v3/repos/adaiversen/amber-thistle. */
  pathname: string;
  /** pathname split on '/', empty segments dropped, each segment percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** The full request body (empty for bodyless requests). */
  body: Buffer;
  /** The request's Authorization header, verbatim, when present. */
  authorization: string | null;
  /** Monotonic per-process request counter, the request id's tail. */
  requestSeq: number;
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function requestIdOf(ctx: WebContext): string {
  return `anvil-${ctx.requestSeq.toString(16).padStart(8, '0')}`;
}

/** Answer with a JSON body; every API reply carries a non-empty X-GitHub-Request-Id. */
export function sendJson(ctx: WebContext, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestIdOf(ctx),
    ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  ctx.res.end(text);
}

/** Answer with raw bytes (the git protocol's replies), still carrying a request id. */
export function sendBytes(
  ctx: WebContext,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestIdOf(ctx),
    'content-length': body.length,
    ...headers,
  });
  ctx.res.end(body);
}

/** A GitHub-shaped error: a JSON body with a non-empty string message. */
export function sendError(ctx: WebContext, status: number, message: string): void {
  sendJson(ctx, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

export function notFound(ctx: WebContext): void {
  sendError(ctx, 404, 'Not Found');
}

/** The parsed JSON body, or the marker a caller turns into a 400. */
export function jsonBody(ctx: WebContext): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(ctx.body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

export function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

export function boolField(value: Record<string, unknown>, key: string): boolean | undefined {
  const field = value[key];
  return typeof field === 'boolean' ? field : undefined;
}
