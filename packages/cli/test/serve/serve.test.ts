import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startDaemon, type RunningDaemon } from '../../../daemon/test/helpers/authorised-daemon.js';
import { startUiServer, type UiServer } from '../../src/lib/serve/ui-server.js';
import { isLocalHostHeader, isLocalOrigin } from '../../src/lib/serve/guard.js';
import { RemoteAccessControl } from '../../src/lib/host/remote-access.js';

function withAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-cli-assets-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>puddle</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("hi")');
  writeFileSync(join(dir, 'assets', 'worker.mjs'), 'export default true');
  return dir;
}

describe('guard predicates', () => {
  it('accepts local hosts on any port and rejects foreign ones', () => {
    expect(isLocalHostHeader('localhost:7433')).toBe(true);
    expect(isLocalHostHeader('127.0.0.1:9999')).toBe(true);
    expect(isLocalHostHeader('[::1]:7433')).toBe(true);
    expect(isLocalHostHeader('evil.example.com:7433')).toBe(false);
    expect(isLocalHostHeader(undefined)).toBe(false);
  });
  it('accepts absent/null/local Origins, rejects foreign', () => {
    expect(isLocalOrigin(undefined)).toBe(true);
    expect(isLocalOrigin('null')).toBe(true);
    expect(isLocalOrigin('http://localhost:5173')).toBe(true);
    expect(isLocalOrigin('https://evil.example.com')).toBe(false);
    expect(isLocalOrigin(':::garbage')).toBe(false);
  });
});

describe('UI server in front of a real daemon', () => {
  let daemon: RunningDaemon;
  let ui: UiServer;
  let refreshes = 0;
  let credential: string;
  const remoteCommands: string[] = [];

  beforeAll(async () => {
    daemon = await startDaemon({
      home: mkdtempSync(join(tmpdir(), 'puddle-cli-home-')),
      port: 0,
      adapters: [],
      version: 'cli-test',
    });
    ui = await startUiServer({
      assetsDir: withAssets(),
      identity: 'local',
      authHome: daemon.paths.home,
      authority: daemon.connection,
      port: 0 + 17500, // fixed-ish start; auto-picks the next free
      target: { host: '127.0.0.1', port: daemon.port },
      control: { onRefresh: () => (refreshes += 1) },
      localSync: {
        file: join(mkdtempSync(join(tmpdir(), 'puddle-cli-sync-')), 'local-sync.json'),
      },
      remoteAccess: new RemoteAccessControl({
        kind: 'local',
        label: 'fixture',
        readFile: async () => null,
        copyTo: async () => {},
        dispose() {},
        exec: async (command) => {
          remoteCommands.push(command);
          return {
            code: 0,
            stderr: '',
            stdout: command.includes('--version')
              ? 'cockpit controls 2'
              : command.endsWith('--inspect')
                ? JSON.stringify({
                    availability: 'ready',
                    configured: false,
                    enabled: false,
                    connected: false,
                    supervisor: null,
                    devices: [],
                  })
                : JSON.stringify({ enabled: false }),
          };
        },
      }),
    });
    const invitation = new URLSearchParams(new URL(ui.createInvitation()).hash.slice(1)).get(
      'invite',
    );
    const response = await fetch(ui.origin + '/cockpit/bootstrap', {
      method: 'POST',
      headers: { origin: ui.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ invitation }),
    });
    credential = ((await response.json()) as { credential: string }).credential;
  });
  afterAll(async () => {
    await ui.close();
    await daemon.stop();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${ui.origin}${path}`, {
      headers: { host: `localhost:${ui.port}`, ...headers },
    });

  it('authenticates remote controls and rejects cross-origin, arbitrary and unreviewed operations before host dispatch', async () => {
    remoteCommands.length = 0;
    expect((await get('/cockpit/remote?profile=0123456789')).status).toBe(401);
    const post = (body: unknown, origin: string | undefined = ui.origin) =>
      fetch(ui.origin + '/cockpit/remote?profile=0123456789', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await post({ t: 'disable' }, 'https://foreign.example.test')).status).toBe(403);
    expect((await post({ t: 'disable' }, '')).status).toBe(403);
    expect((await post({ t: 'run', command: 'anything' })).status).toBe(400);
    expect((await post({ t: 'enable', managed: false })).status).toBe(400);
    for (const path of [
      '/cockpit/remote',
      '/cockpit/remote?profile=../other',
      '/cockpit/remote?profile=0123456789&profile=aaaaaaaaaa',
    ])
      expect((await get(path, { authorization: `Bearer ${credential}` })).status).toBe(400);
    expect(remoteCommands).toEqual([]);
    const status = await get('/cockpit/remote?profile=0123456789', {
      authorization: `Bearer ${credential}`,
    });
    expect(status.status).toBe(200);
    expect(status.headers.get('cache-control')).toBe('no-store');
    expect((await status.json()).configured).toBe(false);
    expect((await post({ t: 'disable' })).status).toBe(200);
    expect(remoteCommands.at(-1)).toMatch(/--admin$/);
  });

  it('protects registration polling with cockpit authority and exact origins', async () => {
    const path = '/cockpit/remote/registration';
    expect((await get(path)).status).toBe(401);
    const check = (
      origin?: string,
      body: object = { service: 'https://relay.example.test', code: 'a'.repeat(64) },
    ) =>
      fetch(ui.origin + path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await check()).status).toBe(403);
    expect((await check('https://foreign.example.test')).status).toBe(403);
    expect(
      (await check(ui.origin, { service: 'http://relay.example.test', code: 'a'.repeat(64) }))
        .status,
    ).toBe(400);
    expect((await get(path, { authorization: `Bearer ${credential}` })).status).toBe(405);
  });

  it('serves the UI tokenlessly with SPA fallback and confinement', async () => {
    expect(await (await get('/')).text()).toContain('puddle');
    expect((await get('/assets/app.js')).headers.get('content-type')).toContain('javascript');
    expect((await get('/assets/worker.mjs')).headers.get('content-type')).toContain('javascript');
    expect(await (await get('/project/42')).text()).toContain('puddle');
    const escape = await get('/assets/..%2f..%2f..%2f..%2fetc%2fpasswd');
    expect(await escape.text()).not.toContain('root:');
  });

  it('404s a missing asset instead of SPA-falling-back to HTML', async () => {
    const missing = await get('/assets/index-abc123.js');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).not.toContain('text/html');
  });

  it('preserves application paths and fragments through a target-scoped proxy grant', async () => {
    const prefix = `/proxy/${crypto.randomUUID()}/3000/`;
    const response = await fetch(ui.origin + '/cockpit/proxy-grant', {
      method: 'POST',
      headers: {
        origin: ui.origin,
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        session: prefix.split('/')[2],
        port: 3000,
        path: '/app?query=yes#section',
      }),
    });
    expect(response.status).toBe(200);
    const target = new URL(((await response.json()) as { url: string }).url);
    const invitation = new URLSearchParams(target.hash.slice(1)).get('invite');
    const exchange = await fetch(target.origin + prefix + '_puddle/exchange', {
      method: 'POST',
      headers: { origin: target.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ invitation }),
    });
    expect(exchange.status).toBe(200);
    expect(await exchange.json()).toEqual({
      url: target.origin + prefix + 'app?query=yes#section',
    });
  });

  it('recovers a proxied page’s stray absolute-path requests via 307', async () => {
    const referer = `http://127.0.0.1:${ui.port}/proxy/sess-1/3000/`;
    const strayAsset = await fetch(`http://127.0.0.1:${ui.port}/assets/main.js`, {
      headers: { origin: `http://127.0.0.1:${ui.port}`, referer },
      redirect: 'manual',
    });
    expect(strayAsset.status).toBe(307);
    expect(strayAsset.headers.get('location')).toBe('/proxy/sess-1/3000/assets/main.js');

    // Absolute fetch('/api/…') from the proxied app belongs to the app, not
    // to puddle's API — it is recovered too, query string intact.
    const strayApi = await fetch(`http://127.0.0.1:${ui.port}/api/items?page=2`, {
      method: 'POST',
      headers: { origin: `http://127.0.0.1:${ui.port}`, referer },
      redirect: 'manual',
    });
    expect(strayApi.status).toBe(307);
    expect(strayApi.headers.get('location')).toBe('/proxy/sess-1/3000/api/items?page=2');
  });

  it('leaves puddle’s own requests and non-proxied referers alone', async () => {
    // The web UI's own API calls carry a non-proxy Referer: proxied verbatim.
    const own = await get('/api/version', {
      referer: `http://localhost:${ui.port}/project/42`,
      authorization: `Bearer ${credential}`,
    });
    expect(own.status).toBe(200);
    // A request already under /proxy/ is never rewritten (no redirect loops).
    const already = await fetch(`http://127.0.0.1:${ui.port}/proxy/sess-1/3000/x.js`, {
      headers: {
        host: `localhost:${ui.port}`,
        referer: `http://localhost:${ui.port}/proxy/sess-1/3000/`,
      },
      redirect: 'manual',
    });
    expect(already.status).not.toBe(307);
    // A foreign Referer host never claims a stray.
    const foreign = await get('/assets/main.js', {
      referer: 'https://evil.example.com/proxy/sess-1/3000/',
    });
    expect(foreign.status).toBe(404);
  });

  it('proxies /api verbatim: bearer passes through, daemon auth still applies', async () => {
    const ok = await get('/api/version', { authorization: `Bearer ${credential}` });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { version: string };
    expect(body.version).toBe('cli-test');
    expect((await get('/api/version')).status).toBe(401); // daemon's 401, proxied
  });

  it('applies Host/Origin checks at the CLI port before proxying', async () => {
    // fetch strips Host (a spec-forbidden header) — send the DNS-rebinding
    // shape with a raw node:http request instead.
    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: ui.port,
          path: '/api/version',
          headers: { host: 'evil.example.com', authorization: `Bearer ${credential}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(badHostStatus).toBe(403);
    const badOrigin = await get('/api/version', {
      origin: 'https://evil.example.com',
      authorization: `Bearer ${credential}`,
    });
    expect(badOrigin.status).toBe(403);
  });

  it('POST /cockpit/refresh: token-gated, 202 fires the callback exactly once', async () => {
    const before = refreshes;
    // Wrong or missing token → 401, no callback.
    const post = (headers: Record<string, string> = {}) =>
      fetch(`${ui.origin}/cockpit/refresh`, {
        method: 'POST',
        headers: {
          host: `localhost:${ui.port}`,
          origin: ui.origin,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ refreshId: crypto.randomUUID() }),
      });
    expect((await post()).status).toBe(401);
    expect((await post({ authorization: 'Bearer wrong' })).status).toBe(401);
    // Non-POST → 405; foreign Origin → 403 (same discipline as /api).
    expect((await get('/cockpit/refresh', { authorization: `Bearer ${credential}` })).status).toBe(
      404,
    );
    expect(
      (
        await post({
          authorization: `Bearer ${credential}`,
          origin: 'https://evil.example.com',
        })
      ).status,
    ).toBe(403);
    expect(refreshes).toBe(before);
    // The real thing: 202 with the refreshing body, callback fired.
    const accepted = await post({ authorization: `Bearer ${credential}` });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ status: 'refreshing', instance: ui.nonce });
    await new Promise((resolve) => setImmediate(resolve)); // the deferred callback
    expect(refreshes).toBe(before + 1);
  });

  it('GET/PUT /cockpit/local-sync: token-gated, merges per profile key, survives rereads', async () => {
    const call = (init: RequestInit & { headers?: Record<string, string> } = {}) =>
      fetch(`${ui.origin}/cockpit/local-sync`, {
        ...init,
        headers: { host: `localhost:${ui.port}`, origin: ui.origin, ...init.headers },
      });
    expect((await call()).status).toBe(401);
    expect((await call({ headers: { authorization: 'Bearer wrong' } })).status).toBe(401);

    const auth = { authorization: `Bearer ${credential}`, 'content-type': 'application/json' };
    // Empty store before any write.
    expect(await (await call({ headers: auth })).json()).toEqual({ version: 1, profiles: {} });

    const entry = { enabled: true, groups: ['appearance'], doc: { appearance: { theme: 'dark' } } };
    const put = await call({
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ profile: 'alice', entry }),
    });
    expect(put.status).toBe(200);

    // A second profile's write merges rather than replacing the file.
    await call({
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ profile: 'bob', entry: { ...entry, enabled: false } }),
    });
    const store = (await (await call({ headers: auth })).json()) as {
      profiles: Record<string, { enabled: boolean }>;
    };
    expect(Object.keys(store.profiles).sort()).toEqual(['alice', 'bob']);
    expect(store.profiles['alice']!.enabled).toBe(true);
    expect(store.profiles['bob']!.enabled).toBe(false);

    // Malformed writes are rejected without touching the store.
    expect((await call({ method: 'PUT', headers: auth, body: '{"profile":""}' })).status).toBe(400);
    expect((await call({ method: 'DELETE', headers: auth })).status).toBe(405);
  });

  it('synthesises a daemon_unreachable 502 when the target is down', async () => {
    ui.setTarget({ host: '127.0.0.1', port: 1 }); // nothing listens there
    const res = await get('/api/version', { authorization: `Bearer ${credential}` });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('upstream_unavailable');
    ui.setTarget({ host: '127.0.0.1', port: daemon.port });
    expect((await get('/api/version', { authorization: `Bearer ${credential}` })).status).toBe(200);
  });

  it('splices the /ws upgrade through to the daemon gateway', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ui.port}/ws`, {
      headers: { host: `localhost:${ui.port}`, origin: ui.origin },
    });
    const messages: Array<{ t: string }> = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data)) as { t: string }));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    // Auth then attach to a nonexistent session: the daemon's error frame
    // proves both directions of the splice.
    ws.send(JSON.stringify({ t: 'auth', token: credential }));
    await new Promise<void>((resolve) => {
      const check = () => {
        if (messages.some((m) => m.t === 'authenticated')) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    ws.send(JSON.stringify({ t: 'attach', session: 'nope', term: 'agent', cols: 80, rows: 24 }));
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (messages.some((m) => m.t === 'error')) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    expect(messages.some((m) => m.t === 'error')).toBe(true);
    ws.close();
  });

  it('refuses a WS upgrade with a foreign Host at the CLI port', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ui.port}/ws`, {
      headers: { host: 'evil.example.com' },
    });
    const outcome = await new Promise<string>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', (e) => resolve(String(e)));
    });
    expect(outcome).toContain('403');
  });
});
