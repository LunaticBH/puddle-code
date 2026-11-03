import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import type { SessionStore } from '../db/stores/sessions.js';
import type { PortScanner } from '../ports/scanner.js';
import { ApiError } from '../http/errors.js';
import { stripProxyCookie, stripTokenParam } from './auth.js';

/**
 * Hop-by-hop headers (RFC 7230 §6.1): meaningful only for a single transport
 * connection, never forwarded through a proxy. `upgrade` is here too — a plain
 * HTTP forward never carries one; the raw upgrade listener (upgrade.ts) owns
 * WebSocket handshakes with its own, deliberately different, header rules.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Node request statuses that MUST NOT carry a body (the Response ctor throws otherwise). */
function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 304 || (status >= 100 && status < 200);
}

export interface HttpProxyDeps {
  sessions: Pick<SessionStore, 'get'>;
  scanner: Pick<PortScanner, 'hasPort'> & Partial<Pick<PortScanner, 'upstreamHost'>>;
}

/**
 * The tier-2 reverse proxy's HTTP half (SPEC §9). Mounted at `/proxy`; auth and
 * host/origin guards are applied by the caller (app.ts) ahead of this router.
 * Forwards to `127.0.0.1:<port>` via raw `node:http` — not `fetch` — so we keep
 * full control of hop-by-hop headers, the `Host` normalisation Vite's
 * `allowedHosts` wants, and streaming in both directions (SSE, chunked).
 */
export function proxyRoutes(deps: HttpProxyDeps): Hono {
  const app = new Hono();
  app.all('/:sid/:port', (c) => handle(c, deps));
  app.all('/:sid/:port/*', (c) => handle(c, deps));
  return app;
}

async function handle(c: Context, deps: HttpProxyDeps): Promise<Response> {
  const sid = c.req.param('sid') ?? '';
  const port = c.req.param('port') ?? '';
  const prefix = `/proxy/${sid}/${port}`;
  const parsed = new URL(c.req.url);

  // A WebSocket handshake that reaches the app is a discard: @hono/node-server
  // still runs the app for `upgrade` requests but throws its Response away, and
  // its lone upgrade listener only destroys unclaimed sockets when
  // `listenerCount('upgrade') === 1` — our raw listener (registered second in
  // daemon.ts) has already claimed and forwarded it (verified: @hono/node-server 2.0.8).
  if (c.req.header('upgrade')?.toLowerCase() === 'websocket') {
    return c.body(null, 426);
  }

  // Bare form (no trailing slash) → 302 to the slash form so the proxied app's
  // relative asset URLs resolve under `/proxy/<sid>/<port>/`. Query preserved,
  // minus any stray puddle_token (auth was already satisfied to get here — keep
  // the daemon token out of the address bar).
  if (parsed.pathname === prefix) {
    return c.body(null, 302, { Location: `${prefix}/${stripTokenParam(parsed.search)}` });
  }

  // Validation order: session exists → port is a valid integer → port is
  // actually listening in the session's process tree (one fresh re-scan lives
  // inside hasPort — SPEC §9; don't double it).
  deps.sessions.get(sid); // throws ApiError.notFound (404) when unknown
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw ApiError.badRequest('invalid_port', `${port} is not a valid port (1-65535)`);
  }
  if (!(await deps.scanner.hasPort(sid, portNum))) {
    throw new ApiError(
      403,
      'port_not_detected',
      `port ${portNum} is not listening in session ${sid}'s process tree`,
    );
  }

  // RAW path after the prefix, textually sliced — never decoded/re-encoded, so
  // percent-escapes reach the upstream byte-for-byte. Query preserved verbatim
  // EXCEPT the puddle_token pair: it can coexist with cookie/bearer auth (the
  // 302 strip only fires on the query-auth GET branch) and the daemon token
  // must never land in an upstream server's access logs.
  const rawPath = parsed.pathname.slice(prefix.length) || '/';
  const targetPath = rawPath + stripTokenParam(parsed.search);

  const outHeaders = forwardHeaders(c.req.header(), portNum);
  const method = c.req.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const host = (await deps.scanner.upstreamHost?.(sid, portNum)) ?? '127.0.0.1';

  let upstreamRes: IncomingMessage;
  try {
    upstreamRes = await new Promise<IncomingMessage>((resolve, reject) => {
      const upstreamReq = httpRequest(
        { host, port: portNum, method, path: targetPath, headers: outHeaders },
        resolve,
      );
      // Connect/first-byte timeout only: cleared once headers arrive, so a
      // long-lived SSE/chunked response is never cut off mid-stream.
      const timer = setTimeout(() => {
        upstreamReq.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' }));
      }, 5000);
      upstreamReq.on('response', () => clearTimeout(timer));
      upstreamReq.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      // If the client disconnects before we've responded, abort upstream too.
      c.req.raw.signal.addEventListener('abort', () => upstreamReq.destroy(), { once: true });
      if (hasBody && c.req.raw.body)
        Readable.fromWeb(c.req.raw.body as import('node:stream/web').ReadableStream).pipe(
          upstreamReq,
        );
      else upstreamReq.end();
    });
  } catch {
    throw new ApiError(
      502,
      'upstream_unreachable',
      `could not reach ${host.includes(':') ? `[${host}]` : host}:${portNum}`,
    );
  }

  const status = upstreamRes.statusCode ?? 502;
  const resHeaders = responseHeaders(upstreamRes);
  if (isBodylessStatus(status)) {
    upstreamRes.resume(); // drain so the socket frees
    return new Response(null, { status, headers: resHeaders });
  }
  return new Response(Readable.toWeb(upstreamRes) as ReadableStream, {
    status,
    headers: resHeaders,
  });
}

/** Copy request headers minus hop-by-hop, strip only `puddle_proxy`, rewrite Host. */
function forwardHeaders(headers: Record<string, string>, port: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name) || name === 'host') continue;
    // Proxy auth credentials must never reach the upstream: a client that
    // authenticated with `Authorization: Bearer <daemon-token>` would otherwise
    // hand the full-RCE token to a session's dev server (potentially
    // agent-generated code). The upstream's own auth, if any, rides its own
    // headers — not ours (SPEC §9).
    if (name === 'x-puddle-application-authorization') {
      out.authorization = value;
      continue;
    }
    if (name === 'authorization' || name.startsWith('x-puddle-')) continue;
    if (name === 'cookie') {
      const kept = stripProxyCookie(value);
      if (kept !== undefined) out.cookie = kept;
      continue;
    }
    out[name] = value;
  }
  // Vite's allowedHosts trusts 127.0.0.1; the daemon's public Host must not leak.
  // No x-forwarded-* in v1: nothing downstream consumes it (additive later).
  out.host = `127.0.0.1:${port}`;
  return out;
}

/** Upstream response headers minus hop-by-hop; multi-valued set-cookie preserved. */
function responseHeaders(res: IncomingMessage): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
  }
  return out;
}
