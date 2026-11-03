import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  browserBootstrapSchema,
  cockpitRefreshRequestSchema,
  proxyGrantRequestSchema,
} from '@puddle/shared';
import type { ConnectionAuthority } from '../auth/connection-authority.js';
import { startLauncher } from '../auth/launcher.js';
import { clientHome } from '../paths.js';
import { CliError } from '../types.js';
import { BrowserAuthority } from './browser-authority.js';
import { exactOrigin, fail, json, readJson } from './http-auth.js';
import { handleLocalSync, type LocalSyncOptions } from './local-sync.js';
import { createStaticHandler } from './static.js';
import { handleProxy, proxyPrefix } from './proxy-gateway.js';
import {
  ProxySocketTracker,
  proxyRequest,
  proxyUpgrade,
  refuse,
  type ProxyTarget,
} from './proxy.js';
import { WsBridge } from './ws-bridge.js';
import type { RemoteAccessControl } from '../host/remote-access.js';
import { remoteAccessHandler } from './remote-access.js';
import { checkRemoteRegistration } from './remote-registration.js';
import { fileManagerHandler } from './file-manager.js';
import type { LocalFileManager } from '../host/file-manager.js';

export interface UiServerOptions {
  assetsDir: string;
  port?: number;
  strictPort?: boolean;
  avoidPort?: number;
  target: ProxyTarget;
  authority: ConnectionAuthority;
  /** Stable target identity, independent of tunnel/local port changes. */
  identity: string;
  authHome?: string;
  /** Vite fronts this same gateway at its own listener port. */
  browserPort?: number;
  refreshId?: string;
  control?: { onRefresh: (refreshId: string) => void };
  localSync?: LocalSyncOptions;
  remoteAccess?: RemoteAccessControl;
  fileManager?: LocalFileManager;
}
export interface UiServer {
  port: number;
  origin: string;
  nonce: string;
  launcherPath: string;
  createInvitation(): string;
  setTarget(target: ProxyTarget): void;
  close(): Promise<void>;
}
export const DEFAULT_UI_PORT = 7433;
const MAX_PORT_PROBES = 50;

export async function startUiServer(opts: UiServerOptions): Promise<UiServer> {
  const target = { ...opts.target };
  const authority = opts.authority;
  const tracker = new ProxySocketTracker();
  const serveStatic = createStaticHandler(opts.assetsDir);
  const handleRemoteAccess = remoteAccessHandler(opts.remoteAccess);
  const handleFileManager = fileManagerHandler(
    opts.identity === 'local' ? opts.fileManager : undefined,
  );
  const nonce = randomUUID();
  let origin = '';
  let proxyOrigin = '';
  let browsers: BrowserAuthority;
  let refreshing: string | null = null;
  const server = createServer((req, res) => {
    res.setHeader('x-puddle-cockpit', nonce);
    res.setHeader('referrer-policy', 'no-referrer');
    void (async () => {
      if (!browsers) return fail(res, 503, 'upstream_unavailable');
      if (req.headers.host === new URL(proxyOrigin).host)
        return handleProxy(req, res, proxyOrigin, browsers, authority, target);
      if (!exactOrigin(req, origin, !['GET', 'HEAD'].includes(req.method ?? '')))
        return fail(res, 403, 'forbidden_origin');
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname === '/cockpit/bootstrap' && req.method === 'POST') {
        if (!exactOrigin(req, origin, true)) return fail(res, 403, 'forbidden_origin');
        const body = browserBootstrapSchema.parse(await readJson(req));
        const credential = browsers.exchange(body.invitation);
        return credential ? json(res, 200, { credential }) : fail(res, 401, 'browser_rejected');
      }
      if (url.pathname.startsWith('/proxy')) return fail(res, 404, 'not_found');
      const protectedPath =
        url.pathname === '/api' ||
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/cockpit/');
      if (!protectedPath) {
        serveStatic(req, res);
        return;
      }
      const browser = browsers.authenticate(
        req.headers.authorization?.replace(/^Bearer /, '') ?? '',
      );
      if (!browser)
        return fail(res, 401, 'browser_rejected', 'Run puddle launch to authorise this browser.');
      const unbind = browsers.bind(browser, () => res.destroy());
      res.once('close', unbind);
      if (url.pathname === '/cockpit/logout' && req.method === 'POST') {
        unbind();
        browsers.revoke(browser);
        return json(res, 200, { status: 'revoked' });
      }
      if (url.pathname === '/cockpit/status' && req.method === 'GET') {
        return json(res, 200, {
          instance: nonce,
          refreshId: opts.refreshId ?? null,
          upstream: authority.state,
        });
      }
      if (url.pathname === '/cockpit/local-sync')
        return handleLocalSync(req, res, opts.localSync, () => browsers.valid(browser));
      if (url.pathname === '/cockpit/file-manager')
        return handleFileManager(req, res, () => browsers.valid(browser));
      if (url.pathname === '/cockpit/remote')
        return handleRemoteAccess(req, res, () => browsers.valid(browser));
      if (url.pathname === '/cockpit/remote/registration') {
        if (!opts.remoteAccess) return fail(res, 404, 'remote_controls_unavailable');
        return checkRemoteRegistration(req, res, () => browsers.valid(browser));
      }
      if (url.pathname === '/cockpit/refresh' && req.method === 'POST') {
        if (!opts.control) return fail(res, 404, 'refresh_unavailable');
        const body = cockpitRefreshRequestSchema.parse(await readJson(req));
        if (!browsers.valid(browser)) return fail(res, 401, 'browser_rejected');
        const first = refreshing === null;
        refreshing ??= body.refreshId;
        browsers.persist();
        json(res, 202, { status: 'refreshing', refreshId: refreshing, instance: nonce });
        if (first) setImmediate(() => opts.control?.onRefresh(refreshing!));
        return;
      }
      if (url.pathname === '/cockpit/proxy-grant' && req.method === 'POST') {
        if (authority.state !== 'ready') return fail(res, 503, authority.state);
        const body = proxyGrantRequestSchema.parse(await readJson(req));
        if (!browsers.valid(browser)) return fail(res, 401, 'browser_rejected');
        const prefix = `/proxy/${body.session}/${body.port}/`;
        if (
          !body.path.startsWith('/') ||
          body.path.startsWith('//') ||
          body.path.includes('\\') ||
          /[\r\n]/.test(body.path)
        )
          return fail(res, 400, 'bad_request');
        const path = prefix + body.path.slice(1);
        if (!new URL(path, proxyOrigin).pathname.startsWith(prefix))
          return fail(res, 400, 'bad_request');
        const invitation = browsers.proxyInvite(browser, prefix, path);
        return json(res, 200, { url: `${proxyOrigin}${prefix}_puddle/enter#invite=${invitation}` });
      }
      if (!url.pathname.startsWith('/api/')) return fail(res, 404, 'not_found');
      if (authority.state !== 'ready') return fail(res, 503, authority.state);
      proxyRequest(req, res, target, { authority, browsers, browser });
    })().catch(() => {
      if (!res.headersSent) fail(res, 400, 'bad_request');
      else res.destroy();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    if (!browsers) return refuse(socket, 503, 'Unavailable');
    if (req.headers.host === new URL(proxyOrigin).host) {
      if (!exactOrigin(req, proxyOrigin, true)) return refuse(socket, 403, 'Forbidden');
      const prefix = proxyPrefix(new URL(req.url ?? '/', proxyOrigin).pathname);
      const browser = prefix && browsers.proxyBrowser(req.headers.cookie, prefix);
      if (!browser) return refuse(socket, 401, 'Unauthorized');
      if (authority.state !== 'ready') return refuse(socket, 503, 'Unavailable');
      try {
        proxyUpgrade(req, socket, head, target, tracker, { authority, browsers, browser });
      } catch {
        refuse(socket, 503, 'Unavailable');
      }
      return;
    }
    if (!exactOrigin(req, origin, true)) return refuse(socket, 403, 'Forbidden');
    if (req.url !== '/ws') return refuse(socket, 404, 'Not Found');
    bridge.upgrade(req, socket, head);
  });
  const port = await listen(
    server,
    opts.port ?? DEFAULT_UI_PORT,
    opts.strictPort ?? false,
    opts.avoidPort,
  );
  origin = `http://localhost:${opts.browserPort ?? port}`;
  proxyOrigin = `http://127.0.0.1:${opts.browserPort ?? port}`;
  const home = opts.authHome ?? clientHome();
  try {
    browsers = new BrowserAuthority(home, origin, opts.identity);
  } catch (err) {
    server.close();
    throw err;
  }
  const bridge = new WsBridge(browsers, authority, target);
  const createInvitation = () =>
    `${origin}/${opts.identity === 'local' ? '' : `?host=${encodeURIComponent(opts.identity)}`}#invite=${browsers.invite()}`;
  const launcher = await startLauncher(home, `${opts.identity}:${origin}`, createInvitation);
  return {
    port,
    origin,
    nonce,
    launcherPath: launcher.path,
    createInvitation,
    setTarget(next) {
      target.host = next.host;
      target.port = next.port;
    },
    async close() {
      await launcher.close();
      browsers.close();
      bridge.close();
      tracker.destroyAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function listen(
  server: Server,
  startPort: number,
  strict: boolean,
  avoidPort?: number,
): Promise<number> {
  for (let probe = 0; probe < MAX_PORT_PROBES; probe += 1) {
    const port = startPort + probe;
    if (!strict && port === avoidPort) continue;
    const ok = await new Promise<boolean>((resolve, rejectListen) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE') resolve(false);
        else rejectListen(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    if (ok) return (server.address() as import('node:net').AddressInfo).port;
    if (strict) {
      throw new CliError(
        'port_in_use',
        `port ${startPort} is already in use`,
        'drop --port to let puddle pick the next free port',
      );
    }
  }
  throw new CliError(
    'port_in_use',
    `no free port found in ${startPort}–${startPort + MAX_PORT_PROBES - 1}`,
  );
}
