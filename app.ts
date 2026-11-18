// app.ts — the HTTP server: routing, bearer auth, JSON framing, and the git
// smart-HTTP endpoints. createApp() returns a plain node:http Server, as the
// starter's main.ts expects. Every reply carries X-GitHub-Request-Id and a
// JSON content type (except the git routes, which carry git content types).

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Store } from './store.ts';
import { handleRest, HttpError } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { advertiseV0, advertiseV2, handleReceivePack, handleUploadPack } from './git.ts';

/** The bearer token the env presents (the same token is in this process's env). */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function requestId(): string {
  return `req_${randomBytes(8).toString('hex')}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, reqId: string, status: number, value: unknown, extra?: Record<string, string>): void {
  const body = value === '' ? '' : JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': reqId,
    ...(extra ?? {}),
  });
  res.end(body);
}

function sendRaw(res: ServerResponse, reqId: string, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': reqId,
    'content-length': body.length,
  });
  res.end(body);
}

function isAuthorized(req: IncomingMessage): boolean {
  if (EXPECTED_TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${EXPECTED_TOKEN}`;
}

export function createApp(): Server {
  const store = new Store();

  const server = createServer((req, res) => {
    void (async () => {
      const reqId = requestId();
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';
        const segments = pathname.split('/').filter((part) => part !== '');
        const origin = `http://${req.headers.host ?? 'localhost'}`;

        // GET /healthz — no auth.
        if (pathname === '/healthz') {
          if (method !== 'GET') return sendJson(res, reqId, 404, { message: 'Not Found' });
          return sendJson(res, reqId, 200, { ok: true });
        }

        // POST /mcp — auth required; a non-JSON body is a JSON-RPC parse error.
        if (pathname === '/mcp') {
          if (method !== 'POST') return sendJson(res, reqId, 404, { message: 'Not Found' });
          if (!isAuthorized(req)) return sendJson(res, reqId, 401, { message: 'Requires authentication' });
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = raw.length === 0 ? undefined : JSON.parse(raw.toString('utf8'));
          } catch {
            parsed = undefined;
          }
          const result = handleMcp(store, raw.toString('utf8'), parsed);
          if (result.body === '') {
            res.writeHead(result.status, { 'x-github-request-id': reqId });
            return res.end();
          }
          return sendJson(res, reqId, result.status, result.body);
        }

        // POST /api/graphql — auth required; batched arrays are supported.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') return sendJson(res, reqId, 404, { message: 'Not Found' });
          if (!isAuthorized(req)) return sendJson(res, reqId, 401, { message: 'Requires authentication' });
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            return sendJson(res, reqId, 400, { message: 'Request body is not valid JSON' });
          }
          const result = executeGraphQL(store, parsed);
          return sendJson(res, reqId, result.status, result.body);
        }

        // /api/v3/* — auth required.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!isAuthorized(req)) return sendJson(res, reqId, 401, { message: 'Requires authentication' });
          let parsedBody: unknown;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                parsedBody = JSON.parse(raw.toString('utf8'));
              } catch {
                return sendJson(res, reqId, 400, { message: 'Request body is not valid JSON' });
              }
            }
          }
          try {
            const result = handleRest(store, method, segments.slice(2), url.searchParams, parsedBody, origin);
            if (result.status === 204) {
              res.writeHead(204, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': reqId });
              return res.end();
            }
            return sendJson(res, reqId, result.status, result.body, result.headers);
          } catch (err) {
            if (err instanceof HttpError) return sendJson(res, reqId, err.status, { message: err.message });
            throw err;
          }
        }

        // Git smart HTTP: /<owner>/<repo>.git/info/refs, /git-upload-pack, /git-receive-pack.
        if (segments.length >= 3 && segments[1].endsWith('.git')) {
          const owner = decodeURIComponent(segments[0]);
          const repoName = decodeURIComponent(segments[1].slice(0, -'.git'.length));
          const service = segments[2];
          const user = store.resolveOwner(owner);
          if (!user) return sendJson(res, reqId, 404, { message: 'Not Found' });
          const repo = store.findRepo(repoName);
          if (!repo) return sendJson(res, reqId, 404, { message: 'Not Found' });

          if (service === 'info' && segments[3] === 'refs' && method === 'GET') {
            const serviceParam = url.searchParams.get('service');
            if (serviceParam === 'git-upload-pack') {
              const protocol = req.headers['git-protocol'] === 'version=2' ? '2' : '0';
              const body = protocol === '2' ? advertiseV2() : advertiseV0(repo, 'git-upload-pack');
              return sendRaw(res, reqId, 200, 'application/x-git-upload-pack-advertisement', body);
            }
            if (serviceParam === 'git-receive-pack') {
              return sendRaw(res, reqId, 200, 'application/x-git-receive-pack-advertisement', advertiseV0(repo, 'git-receive-pack'));
            }
            return sendJson(res, reqId, 400, { message: 'service parameter is required' });
          }
          if (service === 'git-upload-pack' && method === 'POST') {
            const raw = await readBody(req);
            const protocol = req.headers['git-protocol'] === 'version=2' ? '2' : '0';
            try {
              const body = handleUploadPack(store, repo, raw, protocol);
              return sendRaw(res, reqId, 200, 'application/x-git-upload-pack-result', body);
            } catch (err) {
              return sendJson(res, reqId, 400, { message: err instanceof Error ? err.message : String(err) });
            }
          }
          if (service === 'git-receive-pack' && method === 'POST') {
            const raw = await readBody(req);
            try {
              const body = handleReceivePack(repo, raw);
              return sendRaw(res, reqId, 200, 'application/x-git-receive-pack-result', body);
            } catch (err) {
              return sendJson(res, reqId, 400, { message: err instanceof Error ? err.message : String(err) });
            }
          }
          return sendJson(res, reqId, 404, { message: 'Not Found' });
        }

        return sendJson(res, reqId, 404, { message: 'Not Found' });
      } catch (err) {
        // Never leak a stack or an HTML page: every failure is a JSON 500.
        try {
          sendJson(res, reqId, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // The response is already gone; nothing more to do.
        }
      }
    })();
  });

  return server;
}
