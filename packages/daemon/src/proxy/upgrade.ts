import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server as HttpServer,
} from 'node:http';
import { Transform, type Duplex } from 'node:stream';
import type { LeaseRegistry } from '../security/leases.js';
import type { SessionStore } from '../db/stores/sessions.js';
import type { PortScanner } from '../ports/scanner.js';
import { isLocalHostHeader, isLocalOrigin } from '../security/middleware.js';
import { stripProxyCookie, stripTokenParam } from './auth.js';
import type { ProxySocketTracker } from './sockets.js';

const PROXY_UPGRADE = /^\/proxy\/([^/]+)\/(\d+)(?:\/.*)?$/;

export interface UpgradeProxyDeps {
  sessions: Pick<SessionStore, 'get'>;
  scanner: Pick<PortScanner, 'hasPort'> & Partial<Pick<PortScanner, 'upstreamHost'>>;
  authority: LeaseRegistry;
  tracker: ProxySocketTracker;
}

/**
 * The tier-2 reverse proxy's WebSocket half (SPEC §9). Registered as a SECOND
 * `'upgrade'` listener on the Node server — MUST be attached AFTER
 * `@hono/node-server`'s `serve()` returns, so the library's own listener exists
 * first: its unclaimed-socket destroy branch only fires when
 * `server.listenerCount('upgrade') === 1`, and our presence (making it 2)
 * disarms it, leaving `/proxy` handshakes for us to claim while `/ws` stays with
 * the library (verified against @hono/node-server 2.0.8). Returns a disposer.
 */
export function attachProxyUpgrade(server: HttpServer, deps: UpgradeProxyDeps): () => void {
  const handler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = PROXY_UPGRADE.exec(pathnameOf(req.url));
    if (!match) return; // not ours — the library's listener owns /ws and the rest
    const [, sid, port] = match;
    if (sid === undefined || port === undefined) return;
    // A rejection (e.g. the scanner's lsof exec failing) must not leave the
    // claimed client socket dangling in limbo — refuse and destroy it.
    forward(req, socket, head, sid, port, deps).catch(() =>
      refuse(socket, 500, 'Internal Server Error'),
    );
  };
  server.on('upgrade', handler);
  return () => server.off('upgrade', handler);
}

async function forward(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  sid: string,
  port: string,
  deps: UpgradeProxyDeps,
): Promise<void> {
  // Security by hand, same order and rules as the HTTP path — but done on the
  // raw socket, since there is no Hono context here.
  if (!isLocalHostHeader(req.headers.host) || !isLocalOrigin(req.headers.origin)) {
    return refuse(socket, 403, 'Forbidden');
  }
  const resource = deps.authority.attach(
    req.headers.authorization?.replace(/^Bearer /, '') ?? '',
    String(req.headers['x-puddle-resource'] ?? ''),
    () => socket.destroy(),
  );
  socket.once('close', () => resource?.release());
  if (!resource) {
    return refuse(socket, 401, 'Unauthorized');
  }
  if (resource.profile) {
    resource.release();
    return refuse(socket, 403, 'Forbidden');
  }
  try {
    deps.sessions.get(sid); // throws when unknown
  } catch {
    return refuse(socket, 404, 'Not Found');
  }
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return refuse(socket, 400, 'Bad Request');
  }
  if (!(await deps.scanner.hasPort(sid, portNum))) {
    return refuse(socket, 403, 'Forbidden');
  }
  const host = (await deps.scanner.upstreamHost?.(sid, portNum)) ?? '127.0.0.1';

  if (!resource.valid()) return refuse(socket, 401, 'Unauthorized');

  // Forward the handshake verbatim EXCEPT: strip the puddle_proxy cookie pair,
  // rewrite Host. connection/upgrade/sec-websocket-* are kept as-is (unlike the
  // HTTP path, they are load-bearing here). Raw path sliced textually.
  const rawPath = pathAfterPrefix(req.url, sid, port);
  const upstreamReq = httpRequest({
    host,
    port: portNum,
    method: req.method,
    path: rawPath,
    headers: upgradeHeaders(req.headers, portNum),
  });

  // Put any early client bytes back on the socket so the later pipe carries them.
  if (head.length > 0) socket.unshift(head);

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead: Buffer) => {
    if (!resource.valid()) {
      upstreamSocket.destroy();
      return;
    }
    if (upstreamHead.length > 0) upstreamSocket.unshift(upstreamHead);
    socket.write(
      statusHead(101, upstreamRes.statusMessage || 'Switching Protocols', upstreamRes.headers),
    );
    deps.tracker.add(socket, upstreamSocket);
    const teardown = () => {
      socket.destroy();
      upstreamSocket.destroy();
    };
    socket.once('close', teardown);
    upstreamSocket.once('close', teardown);
    socket.on('error', teardown);
    upstreamSocket.on('error', teardown);
    const gate = () =>
      new Transform({
        transform(chunk, _encoding, cb) {
          if (resource.valid()) cb(null, chunk);
          else {
            teardown();
            cb();
          }
        },
      });
    socket.pipe(gate()).pipe(upstreamSocket);
    upstreamSocket.pipe(gate()).pipe(socket);
  });

  // Upstream refused the upgrade (a plain HTTP response): relay it and close.
  upstreamReq.on('response', (upstreamRes) => {
    // Node's parser has already de-chunked the body we pipe, so re-advertising
    // `transfer-encoding: chunked` would corrupt the framing — drop it and mark
    // the connection closing so body-end is unambiguous (pipe ends the socket).
    const headers = { ...upstreamRes.headers };
    delete headers['transfer-encoding'];
    headers.connection = 'close';
    socket.write(
      statusHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage ?? '', headers),
    );
    // Tracked so destroyAll() covers a refusal body still streaming at shutdown.
    deps.tracker.add(socket, upstreamRes.socket ?? socket);
    upstreamRes.pipe(socket);
  });
  socket.once('close', () => upstreamReq.destroy());
  upstreamReq.on('error', () => refuse(socket, 502, 'Bad Gateway'));
  upstreamReq.end();
}

/** Extract just the pathname (no query) from a raw request URL. */
function pathnameOf(url: string | undefined): string {
  return new URL(url ?? '/', 'http://localhost').pathname;
}

/**
 * RAW substring after `/proxy/<sid>/<port>`, incl. query, undecoded; defaults
 * to `/`. The `puddle_token` query pair is spliced out (other pairs untouched):
 * it is the documented auth mechanism for Node WS clients, so it is routinely
 * present here, and the daemon token must never reach the upstream's logs.
 */
function pathAfterPrefix(url: string | undefined, sid: string, port: string): string {
  const raw = url ?? '/';
  const prefix = `/proxy/${sid}/${port}`;
  const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : '';
  const q = rest.indexOf('?');
  if (q === -1) return rest.length > 0 ? rest : '/';
  const path = q > 0 ? rest.slice(0, q) : '/'; // a bare `?query` still needs a path
  return path + stripTokenParam(rest.slice(q));
}

/** Copy handshake headers, strip only `puddle_proxy`, rewrite Host, keep the rest. */
function upgradeHeaders(headers: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === 'host') continue;
    // Proxy auth credentials must never reach the upstream: a client that
    // authenticated with `Authorization: Bearer <daemon-token>` would otherwise
    // hand the full-RCE token to a session's dev server (potentially
    // agent-generated code). The upstream's own auth, if any, rides its own
    // headers — not ours (SPEC §9).
    if (name === 'x-puddle-application-authorization') {
      out.authorization = Array.isArray(value) ? value[0] : value;
      continue;
    }
    if (name === 'authorization' || name.startsWith('x-puddle-')) continue;
    if (name === 'cookie') {
      const kept = stripProxyCookie(Array.isArray(value) ? value.join('; ') : value);
      if (kept !== undefined) out.cookie = kept;
      continue;
    }
    out[name] = value;
  }
  out.host = `127.0.0.1:${port}`;
  return out;
}

/** Serialise an HTTP status line + headers block for writing to a raw socket. */
function statusHead(status: number, message: string, headers: IncomingHttpHeaders): string {
  const lines = [`HTTP/1.1 ${status} ${message}`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
  }
  return lines.join('\r\n') + '\r\n\r\n';
}

/** Reject a handshake with a minimal HTTP response, then close the socket. */
function refuse(socket: Duplex, status: number, message: string): void {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.destroy();
}
