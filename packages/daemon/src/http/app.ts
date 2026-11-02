import { isStorageFull } from '../storage/errors.js';
import { storageUnavailable, type StorageMonitor } from '../storage/monitor.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { UpgradeWebSocket } from 'hono/ws';
import { agentSignalRequestSchema } from '@puddle/shared';
import type { AdapterRegistry } from '../agents/registry.js';
import type { AccountStore } from '../db/stores/accounts.js';
import type { ProfileStateStore } from '../db/stores/profile-states.js';
import type { ProfileStore } from '../db/stores/profiles.js';
import type { ProjectStore } from '../db/stores/projects.js';
import type { RemovalStore } from '../db/stores/removals.js';
import type { LayoutStore } from '../db/stores/layouts.js';
import type { ScratchpadStore } from '../db/stores/scratchpad.js';
import type { SessionStore } from '../db/stores/sessions.js';
import type { RepoStore } from '../db/stores/repos.js';
import type { PuddlePaths } from '../paths.js';
import type { PortScanner } from '../ports/scanner.js';
import type { PtyManager } from '../pty/pty-manager.js';
import { profileAccessMiddleware } from '../security/profile-access.js';
import { bearerAuth, hostOriginGuard } from '../security/middleware.js';
import type { LeaseRegistry } from '../security/leases.js';
import { proxyRoutes } from '../proxy/http.js';
import type { ProxySocketTracker } from '../proxy/sockets.js';
import type { ConversationShare } from '../sessions/conversation-share.js';
import type { ConversationCatalogue } from '../sessions/conversation-catalogue.js';
import type { SessionService } from '../sessions/service.js';
import type { CompilationService } from '../compilation/service.js';
import type { LatexProvider } from '../latex/provider.js';
import type { WorktreeManager } from '../worktrees/manager.js';
import type { WsGateway } from '../ws/gateway.js';
import { ApiError } from './errors.js';
import { parseBody } from './validate.js';
import { accountRoutes } from './routes/accounts.js';
import { agentRoutes } from './routes/agents.js';
import { configRoutes } from './routes/config.js';
import type { NotebookKernels } from '../notebooks/kernels.js';
import { notebookRoutes } from './routes/notebooks.js';
import { compilationRoutes } from './routes/compilation.js';
import { fsRoutes } from './routes/fs.js';
import { hostRoutes } from './routes/host.js';
import { profileRoutes } from './routes/profiles.js';
import { projectRoutes } from './routes/projects.js';
import { repoRoutes } from './routes/repos.js';
import { layoutRoutes } from './routes/layouts.js';
import { latexRoutes } from './routes/latex.js';
import { scratchpadRoutes } from './routes/scratchpad.js';
import { sessionRoutes } from './routes/sessions.js';
import { versionRoutes } from './routes/version.js';
import { worktreeRoutes } from './routes/worktrees.js';
import { puddlangRoutes } from './routes/puddlang.js';
import type { PuddlangService } from '../puddlang/service.js';

/** Everything the REST + WS surface needs; `api` is absent in narrow tests. */
export interface AppDeps {
  version: string;
  authority: LeaseRegistry;
  api?: {
    paths: PuddlePaths;
    storage?: StorageMonitor;
    profiles: ProfileStore;
    accounts: AccountStore;
    repos: RepoStore;
    projects: ProjectStore;
    profileStates: ProfileStateStore;
    removals: RemovalStore;
    scratchpad: ScratchpadStore;
    layouts: LayoutStore;
    sessions: SessionStore;
    adapters: AdapterRegistry;
    ptys: PtyManager;
    worktrees: WorktreeManager;
    service: SessionService;
    share: ConversationShare;
    catalogue: ConversationCatalogue;
    scanner: PortScanner;
    tracker: ProxySocketTracker;
    compilation: CompilationService;
    notebooks?: NotebookKernels;
    latex: LatexProvider;
    puddlang?: PuddlangService;
  };
  ws?: {
    gateway: WsGateway;
    upgradeWebSocket: UpgradeWebSocket;
  };
}

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (isStorageFull(err)) {
      deps.api?.storage?.noteFailure(err);
      const failure = storageUnavailable();
      return c.json({ error: { code: failure.code, message: failure.message } }, 507);
    }
    if (err instanceof ApiError) {
      // Cast: Hono types statuses as literals; ours is a runtime value.
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details !== undefined ? { details: err.details } : {}),
          },
        },
        err.status as 400,
      );
    }
    console.error('unhandled error:', err);
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  app.use('/api/*', hostOriginGuard());
  app.use('/api/*', bearerAuth(deps.authority));
  if (deps.api) app.use('/api/*', profileAccessMiddleware(deps.api));
  app.route('/api/version', versionRoutes(deps.version));

  if (deps.api) {
    const api = deps.api;
    if (api.storage) app.get('/api/storage', (c) => c.json(api.storage!.status()));
    app.route('/api/profiles', profileRoutes(api));
    app.route('/api/accounts', accountRoutes(api));
    app.route('/api/agents', agentRoutes(api));
    app.route('/api/repos', repoRoutes(api));
    app.route('/api/projects', projectRoutes(api));
    app.route('/api/scratchpad', scratchpadRoutes(api));
    app.route('/api/layouts', layoutRoutes(api));
    app.route('/api/sessions', sessionRoutes(api));
    app.route('/api/config', configRoutes(api));
    app.route('/api/compilation', compilationRoutes(api));
    if (api.notebooks) app.route('/api/notebooks', notebookRoutes(api.notebooks));
    app.route('/api/latex', latexRoutes(api));
    app.route('/api/fs', fsRoutes());
    app.route('/api/worktrees', worktreeRoutes(api));
    app.route('/api/host', hostRoutes(api));
    if (api.puddlang) app.route('/api/puddlang', puddlangRoutes(api.puddlang));

    // Agent-hook status side-channel (SPEC §4): deliberately OUTSIDE /api —
    // the caller is a hook process on this host with no bearer token; the
    // per-session nonce (injected into the agent PTY env) is the auth. Same
    // Host/Origin discipline as everything else; never proxied by cockpits.
    app.use('/agent-signal', hostOriginGuard());
    // Allow JSON escaping of a 256 KiB reply without unbounded hook bodies.
    app.use('/agent-signal', bodyLimit({ maxSize: 2 * 1024 * 1024 }));
    app.post('/agent-signal', async (c) => {
      const body = await parseBody(c, agentSignalRequestSchema);
      const accepted =
        'state' in body
          ? api.service.signalAgentStatus(body.nonce, body.state)
          : 'turn_id' in body
            ? api.service.signalAgentTurn(body)
            : await api.service.signalAgentLifecycle(body);
      if (!accepted) {
        throw ApiError.notFound('signal', 'nonce');
      }
      return c.body(null, 204);
    });

    // Tier-2 reverse proxy (SPEC §2/§9). Host/Origin guard, then the /proxy auth
    // (bearer/cookie/one-shot query param), then the router — all BEFORE the
    // static catch-all below. WebSocket handshakes are owned by the raw upgrade
    // listener wired in daemon.ts; this router only serves plain HTTP forwards.
    app.use('/proxy/*', hostOriginGuard());
    app.use('/proxy/*', bearerAuth(deps.authority));
    app.route('/proxy', proxyRoutes(api));
  }

  if (deps.ws) {
    const { gateway, upgradeWebSocket } = deps.ws;
    app.use('/ws', hostOriginGuard()); // token auth is the first WS message
    app.get(
      '/ws',
      upgradeWebSocket(() => gateway.connection()),
    );
  }

  // Headless API server (Phase 6): the CLI serves the web UI; unmatched
  // routes 404 here by design.
  return app;
}
