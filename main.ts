// main.ts — trial lifecycle for the github-core-clone-01 forge.
//
// The trial runs this file as `node /bot/main.ts`. It starts the forge, tells
// the suite where to find it, and waits until the suite says the trial is over:
//
//   1. Build the forge (createApp) and listen on port 0, so the kernel picks a
//      free ephemeral port. Never 8080 — that is where the suite listens.
//   2. POST {"port": <the bound port>} to $MAKEFUN_ENV_URL/register, so the
//      suite knows which address and port to dial.
//   3. Long-poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//   4. Shut the forge down and exit 0.
//
// Stdlib only; no dependencies. Node 22. The suite's base URL comes from the
// MAKEFUN_ENV_URL environment variable, which every trial sets.

import { createApp } from './app.ts';

/** How long one register attempt may take before it counts as failed. */
const REGISTER_TIMEOUT_MS = 5_000;
/** How long to keep retrying the register before giving up. */
const REGISTER_BUDGET_MS = 60_000;
/** Pause between register attempts. */
const REGISTER_RETRY_MS = 500;
/** How long one /done poll may stay open (the suite may hold it). */
const DONE_TIMEOUT_MS = 30_000;
/** Pause between /done polls that answer {"done": false}. */
const DONE_RETRY_MS = 250;
/** Longest to wait for a graceful server close before exiting anyway. */
const CLOSE_GRACE_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/** The suite's base URL, without a trailing slash. */
function envBaseUrl(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  const base = raw.replace(/\/+$/, '');
  if (base === '') {
    throw new Error('MAKEFUN_ENV_URL is not set: the trial lifecycle needs it');
  }
  return base;
}

/** POST a JSON body. The reply body is discarded; the register only needs a 2xx. Throws on any failure. */
async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`POST ${url} answered HTTP ${response.status}`);
  }
  await response.arrayBuffer().catch(() => undefined);
}

/** GET a URL and parse its JSON reply. Throws on any failure. */
async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(DONE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} answered HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

/** Start the forge on an ephemeral port and return the port the kernel gave. */
function listenEphemeral(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createApp();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the forge did not bind a port'));
        return;
      }
      process.stdout.write(`[main] forge listening on http://127.0.0.1:${address.port}\n`);
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** Register the bound port with the suite, retrying until the budget runs out. */
async function registerPort(baseUrl: string, port: number): Promise<void> {
  const deadline = Date.now() + REGISTER_BUDGET_MS;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await postJson(`${baseUrl}/register`, { port });
      process.stdout.write(`[main] registered port ${port} with the suite\n`);
      return;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (Date.now() >= deadline) {
        throw new Error(`register failed after ${attempt} attempt(s): ${reason}`);
      }
      process.stderr.write(`[main] register attempt ${attempt} failed (${reason}); retrying\n`);
      await sleep(REGISTER_RETRY_MS);
    }
  }
}

/** Poll /done until the suite answers {"done": true}. Never returns early. */
async function waitUntilDone(baseUrl: string): Promise<void> {
  for (;;) {
    try {
      const reply = (await getJson(`${baseUrl}/done`)) as { done?: unknown };
      if (reply !== null && typeof reply === 'object' && reply.done === true) {
        process.stdout.write('[main] suite answered done; shutting down\n');
        return;
      }
    } catch (err) {
      // The env may be briefly unreachable or may hold the poll open past the
      // timeout; either way the trial is not over, so poll again.
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[main] /done poll failed (${reason}); polling again\n`);
    }
    await sleep(DONE_RETRY_MS);
  }
}

async function main(): Promise<void> {
  const baseUrl = envBaseUrl();
  const forge = await listenEphemeral();
  try {
    await registerPort(baseUrl, forge.port);
    await waitUntilDone(baseUrl);
  } finally {
    // Give in-flight requests a moment to finish, then leave regardless.
    await Promise.race([forge.close(), sleep(CLOSE_GRACE_MS)]);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[main] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
