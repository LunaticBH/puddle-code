import { LeaseRegistry } from '../../src/security/leases.js';
import { bearerAuth } from '../../src/security/middleware.js';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@puddle/shared';
import { ApiError } from '../../src/http/errors.js';
import { hostOriginGuard } from '../../src/security/middleware.js';
import { stripTokenParam } from '../../src/proxy/auth.js';
import { proxyRoutes } from '../../src/proxy/http.js';

const authority = new LeaseRegistry();
const TOKEN = authority.create().token;
const SID = 'session-abcdef';

/**
 * Raw HTTP client — NOT fetch: undici forbids setting `cookie`, `host`, and the
 * hop-by-hop headers this proxy's forwarding rules turn on, so the round-trip
 * has to be driven at the socket level. No redirect following (we assert 302s).
 */
function raw(
  proxyPort: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: proxyPort, method, path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A free TCP port with nothing listening — used to force ECONNREFUSED. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe('tier-2 proxy: auth + HTTP forwarding', () => {
  let upstream: Server;
  let upstreamPort: number;
  let proxy: ServerType;
  let proxyPort: number;
  const allowedPorts = new Set<number>();
  const hasPort = vi.fn(async (_sid: string, port: number) => allowedPorts.has(port));

  const stubSessions = {
    get(id: string): Session {
      if (id !== SID) throw ApiError.notFound('session', id);
      return { id } as Session;
    },
  };

  beforeAll(async () => {
    // Echo upstream: reflects what it received via headers + a JSON body.
    upstream = createServer((req, res) => {
      if (req.url?.startsWith('/status/500')) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('upstream-error');
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const seenBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-seen-url': req.url ?? '',
          'x-seen-host': req.headers.host ?? '',
          'x-seen-cookie': req.headers.cookie ?? '',
          'x-seen-te': req.headers.te ?? '',
          'x-seen-keep': (req.headers['x-keep'] as string) ?? '',
          'x-seen-auth': req.headers.authorization ?? '',
        });
        res.end(JSON.stringify({ method: req.method, url: req.url, body: seenBody }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    upstreamPort = (upstream.address() as AddressInfo).port;

    const app = new Hono();
    app.onError((err, c) => {
      if (err instanceof ApiError) {
        return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
      }
      return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
    });
    app.use('/proxy/*', hostOriginGuard());
    app.use('/proxy/*', bearerAuth(authority));
    app.route('/proxy', proxyRoutes({ sessions: stubSessions, scanner: { hasPort } }));

    await new Promise<void>((resolve) => {
      proxy = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
        proxyPort = info.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => (proxy as Server).close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  beforeEach(() => {
    hasPort.mockClear();
    allowedPorts.clear();
    allowedPorts.add(upstreamPort);
  });

  const bearer = { authorization: `Bearer ${TOKEN}` };

  describe('auth matrix', () => {
    it('rejects a request with no credential (401)', async () => {
      const res = await raw(proxyPort, 'GET', `/proxy/${SID}/${upstreamPort}/`);
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body).error.code).toBe('upstream_expired');
    });

    it('accepts a bearer token (200, forwarded)', async () => {
      const res = await raw(proxyPort, 'GET', `/proxy/${SID}/${upstreamPort}/`, bearer);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).url).toBe('/');
    });

    it('rejects a wrong bearer token (401)', async () => {
      const res = await raw(proxyPort, 'GET', `/proxy/${SID}/${upstreamPort}/`, {
        authorization: `Bearer ${'x'.repeat(64)}`,
      });
      expect(res.status).toBe(401);
    });

    it('rejects legacy cookie and query credentials', async () => {
      for (const [path, headers] of [
        [`/proxy/${SID}/${upstreamPort}/`, { cookie: `puddle_proxy=${TOKEN}` }],
        [`/proxy/${SID}/${upstreamPort}/?puddle_token=${TOKEN}`, {}],
      ] as const) {
        expect((await raw(proxyPort, 'GET', path, headers)).status).toBe(401);
      }
    });
  });

  describe('scoping', () => {
    it('unknown session → 404', async () => {
      const res = await raw(proxyPort, 'GET', `/proxy/nope/${upstreamPort}/`, bearer);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe('not_found');
    });

    it('port not detected → 403, with exactly one fresh re-scan', async () => {
      const other = upstreamPort + 1;
      const res = await raw(proxyPort, 'GET', `/proxy/${SID}/${other}/`, bearer);
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('port_not_detected');
      expect(hasPort).toHaveBeenCalledTimes(1); // the proxy asks once; hasPort owns the re-scan
    });

    it('invalid ports → 400 invalid_port', async () => {
      for (const bad of ['0', '99999', 'abc']) {
        const res = await raw(proxyPort, 'GET', `/proxy/${SID}/${bad}/`, bearer);
        expect(res.status, `port ${bad}`).toBe(400);
        expect(JSON.parse(res.body).error.code).toBe('invalid_port');
      }
      expect(hasPort).not.toHaveBeenCalled(); // rejected before the scan
    });
  });

  describe('forwarding fidelity', () => {
    it('preserves the raw path and query verbatim', async () => {
      const res = await raw(proxyPort, 'GET', `/proxy/${SID}/${upstreamPort}/a/b?x=1`, bearer);
      expect(res.status).toBe(200);
      expect(res.headers['x-seen-url']).toBe('/a/b?x=1');
    });

    it('redirects the bare form to the trailing slash, preserving query', async () => {
      const res = await raw(proxyPort, 'GET', `/proxy/${SID}/${upstreamPort}?x=1`, bearer);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/proxy/${SID}/${upstreamPort}/?x=1`);
    });

    it('splices puddle_token out of the forwarded query when auth came from elsewhere', async () => {
      // Cookie auth satisfies proxyAuth BEFORE the query check, so no 302 fires
      // and the stray param would otherwise reach the upstream's access logs.
      const res = await raw(
        proxyPort,
        'GET',
        `/proxy/${SID}/${upstreamPort}/a?x=%20y&puddle_token=${TOKEN}&b=2`,
        { ...bearer, cookie: `puddle_proxy=${TOKEN}` },
      );
      expect(res.status).toBe(200);
      // Only the token pair is gone; the other pairs are byte-intact (no re-encode).
      expect(res.headers['x-seen-url']).toBe('/a?x=%20y&b=2');
    });

    it('splices puddle_token out on the inline non-GET query-auth path', async () => {
      const res = await raw(
        proxyPort,
        'POST',
        `/proxy/${SID}/${upstreamPort}/p?puddle_token=${TOKEN}`,
        { ...bearer, 'content-type': 'text/plain' },
        'x',
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).url).toBe('/p'); // sole pair removed → bare path
    });

    it('strips puddle_token from the bare-form redirect Location', async () => {
      const res = await raw(
        proxyPort,
        'GET',
        `/proxy/${SID}/${upstreamPort}?puddle_token=${TOKEN}&x=1`,
        {
          ...bearer,
          cookie: `puddle_proxy=${TOKEN}`,
        },
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/proxy/${SID}/${upstreamPort}/?x=1`);
    });

    it('rewrites Host, strips only puddle_proxy from Cookie, drops hop-by-hop', async () => {
      const res = await raw(proxyPort, 'GET', `/proxy/${SID}/${upstreamPort}/`, {
        ...bearer,
        cookie: `puddle_proxy=${TOKEN}; keepme=yes`,
        te: 'trailers',
        'x-keep': 'kept',
      });
      expect(res.status).toBe(200);
      expect(res.headers['x-seen-host']).toBe(`127.0.0.1:${upstreamPort}`);
      expect(res.headers['x-seen-cookie']).toBe('keepme=yes'); // puddle_proxy gone, other survives
      expect(res.headers['x-seen-te']).toBe(''); // hop-by-hop stripped
      expect(res.headers['x-seen-keep']).toBe('kept'); // ordinary header forwarded
      expect(res.headers['x-seen-auth']).toBe(''); // proxy-auth credential never forwarded
    });

    it('never forwards the Authorization header to the upstream', async () => {
      // A client that authenticates with `Authorization: Bearer <daemon-token>`
      // must not hand that full-RCE token to a session's (agent-generated) dev
      // server — the header is dropped even though it satisfied proxy auth.
      const res = await raw(proxyPort, 'GET', `/proxy/${SID}/${upstreamPort}/`, bearer);
      expect(res.status).toBe(200);
      expect(res.headers['x-seen-auth']).toBe('');
    });

    it('splices a percent-encoded puddle_token name out of the forwarded query', async () => {
      // `?puddle%5Ftoken=` WHATWG-decodes to `puddle_token`, so it satisfies
      // query auth — a purely textual strip would leave it in the forward and
      // leak the daemon token upstream. Cookie auth here keeps the forward path
      // (no 302), proving http.ts decodes the pair name before splicing.
      const res = await raw(
        proxyPort,
        'GET',
        `/proxy/${SID}/${upstreamPort}/a?puddle%5Ftoken=${TOKEN}&a=1`,
        { ...bearer, cookie: `puddle_proxy=${TOKEN}` },
      );
      expect(res.status).toBe(200);
      expect(res.headers['x-seen-url']).toBe('/a?a=1');
    });

    it('forwards a POST body byte-for-byte', async () => {
      const payload = JSON.stringify({ hello: 'wörld', n: 42 });
      const res = await raw(
        proxyPort,
        'POST',
        `/proxy/${SID}/${upstreamPort}/submit`,
        { ...bearer, 'content-type': 'application/json' },
        payload,
      );
      expect(res.status).toBe(200);
      const echoed = JSON.parse(res.body);
      expect(echoed.method).toBe('POST');
      expect(echoed.body).toBe(payload);
    });

    it('passes an upstream 500 through as 500 (not 502)', async () => {
      const res = await raw(proxyPort, 'GET', `/proxy/${SID}/${upstreamPort}/status/500`, bearer);
      expect(res.status).toBe(500);
      expect(res.body).toBe('upstream-error');
    });

    it('returns 502 upstream_unreachable when the port refuses the connection', async () => {
      const dead = await closedPort();
      allowedPorts.add(dead); // scanner says it is the session's, but nothing listens
      const res = await raw(proxyPort, 'GET', `/proxy/${SID}/${dead}/`, bearer);
      expect(res.status).toBe(502);
      expect(JSON.parse(res.body).error.code).toBe('upstream_unreachable');
    });
  });
});

describe('stripTokenParam', () => {
  it('decodes a percent-encoded param name before matching (auth via WHATWG decode)', () => {
    // `puddle%5Ftoken` authenticates (searchParams decodes it), so it must also
    // be stripped from the forward — otherwise the daemon token leaks upstream.
    expect(stripTokenParam('?puddle%5Ftoken=T&a=1')).toBe('?a=1');
  });

  it('strips the plain token pair while leaving others byte-intact', () => {
    expect(stripTokenParam('?x=%20y&puddle_token=T&b=2')).toBe('?x=%20y&b=2');
  });

  it('keeps a malformed-escape name (it can never be the token)', () => {
    expect(stripTokenParam('?%zz=1&b=2')).toBe('?%zz=1&b=2');
  });

  it('returns the empty string when the token was the sole pair', () => {
    expect(stripTokenParam('?puddle_token=T')).toBe('');
    expect(stripTokenParam('?puddle%5Ftoken=T')).toBe('');
  });
});
