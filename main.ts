// main.ts — Anvil, a GitHub-compatible forge in a single process.
//
// Wiring, in order: build the shared store, open the HTTP front door on an ephemeral
// port, register that port with the trial environment, then long-poll the environment's
// done flag and exit 0 when the trial ends. Registration and polling retry on a small
// backoff schedule so a slow-starting environment never loses the bot, and shutdown is
// graceful: the listener drains before the process exits.

import { createForgeServer, listenEphemeral } from './app.ts';
import { Store } from './store.ts';

const POLL_INTERVAL_MS = 200;
const REGISTER_ATTEMPTS = 40;

/** Milliseconds since boot, for log lines that make a trial transcript readable. */
const bootMark = Date.now();
function log(event: string, detail = ''): void {
  const elapsed = ((Date.now() - bootMark) / 1000).toFixed(2);
  console.log(`[anvil +${elapsed}s] ${event}${detail === '' ? '' : ` ${detail}`}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff for environment calls: 150ms, growing by a quarter each round, capped at 2s. */
function backoffMs(attempt: number): number {
  return Math.min(2000, Math.round(150 * 1.25 ** attempt));
}

async function postJson(url: string, payload: unknown): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function readJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const value = (await response.json()) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Register the listening port with the environment, retrying until it answers. */
async function registerPort(envUrl: string, port: number): Promise<void> {
  for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt += 1) {
    if (await postJson(`${envUrl}/register`, { port })) {
      log('registered', `port=${port}`);
      return;
    }
    await sleep(backoffMs(attempt));
  }
  log('registration never confirmed; serving anyway', `port=${port}`);
}

/** Poll the environment's done flag until it reports the trial is over. */
async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    const state = await readJson(`${envUrl}/done`);
    if (state !== null && state['done'] === true) return;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function main(): Promise<void> {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/$/, '');
  const token = process.env.MAKEFUN_SHOP_TOKEN;

  const store = new Store();
  const server = createForgeServer(store, { token });
  const port = await listenEphemeral(server);
  log('listening', `port=${port}`);

  let closing = false;
  const shutdown = (reason: string): void => {
    if (closing) return;
    closing = true;
    log('shutting down', reason);
    server.close(() => process.exit(0));
    // A stuck connection must not hold the process open past the trial's patience.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('sigterm'));
  process.on('SIGINT', () => shutdown('sigint'));

  if (envUrl === '') {
    log('MAKEFUN_ENV_URL is not set; serving without registration');
    return; // The listener keeps the process alive for manual runs.
  }
  await registerPort(envUrl, port);
  await waitForDone(envUrl);
  shutdown('trial done');
}

main().catch((err: unknown) => {
  console.error('anvil: fatal', err);
  process.exit(1);
});
