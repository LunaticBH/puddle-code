import { tmpdir } from 'node:os';
import { StorageMonitor } from './storage/monitor.js';
import { createAdaptorServer, upgradeWebSocket, type ServerType } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import type { AgentAdapter } from './agents/adapter.js';
import { isBinaryAvailable } from './agents/binary.js';
import { claudeCode } from './agents/claude-code/index.js';
import { codex } from './agents/codex/index.js';
import { geminiCli } from './agents/gemini-cli/index.js';
import { opencode } from './agents/opencode/index.js';
import { AdapterRegistry } from './agents/registry.js';
import { loadConfig, readConfig } from './config.js';
import { LogRetention } from './logs/retention.js';
import { NotebookKernels } from './notebooks/kernels.js';
import { createCodeProviders } from './code/provider.js';
import { createCodeTerminalLauncher } from './code/terminal.js';
import { CompilationService } from './compilation/service.js';
import { openDatabase } from './db/db.js';
import { AccountStore } from './db/stores/accounts.js';
import { EventStore } from './db/stores/events.js';
import { ProfileStore } from './db/stores/profiles.js';
import { ProfileStateStore } from './db/stores/profile-states.js';
import { ProjectStore } from './db/stores/projects.js';
import { RemovalStore } from './db/stores/removals.js';
import { RepoStore } from './db/stores/repos.js';
import { LayoutStore } from './db/stores/layouts.js';
import { ScratchpadStore } from './db/stores/scratchpad.js';
import { reconcileProfileDirs } from './db/profile-dirs.js';
import { SessionStore } from './db/stores/sessions.js';
import { ConversationStore } from './db/stores/conversations.js';
import { CompilationSettingsStore } from './db/stores/compilation-settings.js';
import { KeyedMutex } from './git/mutex.js';
import { buildApp } from './http/app.js';
import { LogStore } from './logs/log-store.js';
import { LatexProvider } from './latex/provider.js';
import { ensureHome, resolvePaths } from './paths.js';
import { PortScanner } from './ports/scanner.js';
import { attachProxyUpgrade } from './proxy/upgrade.js';
import { ProxySocketTracker } from './proxy/sockets.js';
import type { ConptyJobs } from './pty/conpty-jobs.js';
import { PtyManager } from './pty/pty-manager.js';
import { clearPtyRoots, ptyRootsFile } from './pty/pty-roots.js';
import { TerminalTheme } from './pty/terminal-theme.js';
import { installShellHooks } from './pty/shell-hooks.js';
import { clearRuntime, writeRuntime } from './runtime-file.js';
import { PROTOCOL_VERSION } from '@puddle/shared';
import { LeaseRegistry } from './security/leases.js';
import { ProfileAccess } from './security/profile-access.js';
import { startHostControl } from './security/control.js';
import { ensureToken } from './security/token.js';
import { ConversationShare } from './sessions/conversation-share.js';
import { ConversationCatalogue } from './sessions/conversation-catalogue.js';
import { MarkerFileSync } from './sessions/onboarding.js';
import { reconcilePass } from './sessions/reconcile.js';
import { subscribePushNotifications } from './sessions/push-notifications.js';
import { SessionService } from './sessions/service.js';
import { WorktreeManager } from './worktrees/manager.js';
import { WsGateway } from './ws/gateway.js';
import { PuddlangService } from './puddlang/service.js';
import { PuddlangStore } from './puddlang/store.js';

export interface DaemonOptions {
  /** Overrides PUDDLE_HOME / ~/.puddle (tests). */
  home?: string;
  /** Overrides config.json's port; 0 picks a free port (tests). */
  port?: number;
  /** Adapter set; defaults to the real ones (tests inject fakes). */
  adapters?: AgentAdapter[];
  version?: string;
  /** Quiet window for waiting_input detection (tests shrink it). */
  statusQuietMs?: number;
  /**
   * Accept the host-control `shutdown` request (protocol 25.7): the daemon
   * stops itself, then calls this (index.ts exits). Windows supervision has
   * no service manager to signal. Without it the request is refused.
   */
  onShutdown?: () => void;
  /** Injected for tests; selects the Windows shutdown order. */
  platform?: NodeJS.Platform;
  /**
   * Windows: the ConPTY job host (pty/conpty-jobs.ts), this process's shared
   * one by default; null runs without one (tests of what the process table
   * and the supervisor stop on their own).
   */
  conptyJobs?: ConptyJobs | null;
}

export interface RunningDaemon {
  port: number;
  authority: LeaseRegistry;
  paths: ReturnType<typeof resolvePaths>;
  service: SessionService;
  stop(): Promise<void>;
}

/**
 * Composition root: constructs every subsystem, runs the boot reconcile pass,
 * starts the periodic fetch loop and the HTTP+WS server.
 */
export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  const paths = resolvePaths(opts.home);
  ensureHome(paths);
  const config = loadConfig(paths);
  const authority = new LeaseRegistry();
  let controlInfo: {
    port: number;
    version: { version: string; protocol: typeof PROTOCOL_VERSION };
  } | null = null;
  const failedStartup: Array<() => void | Promise<void>> = [];
  const platform = opts.platform ?? process.platform;
  // A shutdown request can arrive between the bind and startDaemon's return
  // (auto-resume runs in between); it then waits for the stop handle.
  let stopDaemon: (() => Promise<void>) | null = null;
  let shutdownRequested = false;
  const onShutdown = opts.onShutdown;
  const requestShutdown = onShutdown
    ? () => {
        shutdownRequested = true;
        if (stopDaemon) void stopDaemon().then(onShutdown, onShutdown);
      }
    : undefined;
  try {
    const closeControl = await startHostControl(
      paths.home,
      authority,
      () => controlInfo,
      requestShutdown,
    );
    failedStartup.push(closeControl);
    ensureToken(paths);
    const db = openDatabase(paths.dbFile);
    failedStartup.push(() => {
      db.close();
    });

    const profiles = new ProfileStore(db);
    const accounts = new AccountStore(db);
    const repos = new RepoStore(db);
    const projects = new ProjectStore(db);
    const profileStates = new ProfileStateStore(db);
    const removals = new RemovalStore(db);
    const scratchpad = new ScratchpadStore(db);
    const layouts = new LayoutStore(db);
    const sessions = new SessionStore(db);
    const conversations = new ConversationStore(db);
    const events = new EventStore(db);
    const compilationSettings = new CompilationSettingsStore(db);

    const storagePaths = [paths.home, paths.logsDir, paths.worktreesDir, tmpdir()];
    const storage = new StorageMonitor(() => [
      ...storagePaths,
      ...repos.list().map((repo) => repo.path),
      ...sessions
        .list()
        .filter((session) => ['starting', 'running', 'waiting_input'].includes(session.status))
        .map((session) => session.worktree_path),
      ...accounts.list().map((account) => account.config_dir),
    ]);
    // A write to an existing metadata page tests SQLite recovery without replaying
    // any failed user operation or allocating a separate probe database.
    const schemaVersion = db.pragma('user_version', { simple: true }) as number;
    storage.setDatabaseProbe(() => {
      db.pragma(`user_version = ${schemaVersion}`);
    });
    void storage.refresh().catch((error: unknown) => console.warn('Storage check failed:', error));
    storage.start();
    failedStartup.push(() => storage.dispose());
    const logs = new LogStore(paths.logsDir, config.replayBytes, config.logMaxBytes, (degraded) =>
      storage.setLogsDegraded(degraded),
    );
    // Clients report their resolved terminal colours over the WS (14.1); the
    // PTY layer answers agents' OSC 10/11 colour queries from the last report.
    const terminalTheme = new TerminalTheme();
    const ptys = new PtyManager(
      logs,
      terminalTheme,
      paths.logsDir,
      (degraded) => storage.setLogsDegraded(degraded, 'screens'),
      // The supervisor's lead to what a crashed daemon's PTYs left running.
      platform === 'win32'
        ? { rootsFile: ptyRootsFile(paths.home), jobs: opts.conptyJobs }
        : undefined,
    );
    const shellHooks = installShellHooks(paths);
    failedStartup.push(async () => {
      ptys.killAll();
      if (platform === 'win32') {
        await settleConptys(ptys);
        await ptys.settled(SETTLE_MS);
      }
      logs.closeAll();
    });
    const scanner = new PortScanner({ ptys });
    const worktrees = new WorktreeManager({
      paths,
      storage,
      mutex: new KeyedMutex(),
      repos,
      sessions,
    });
    const latex = new LatexProvider({ sessions, repos });
    const notebooks = new NotebookKernels({ sessions, repos });
    failedStartup.push(() => notebooks.dispose());
    const onboarding = new MarkerFileSync({ repos, events, sessions, storage });
    failedStartup.push(() => onboarding.dispose());
    const adapters = new AdapterRegistry(opts.adapters ?? [claudeCode, codex, opencode, geminiCli]);
    // Migration 004 rewrote config-dir paths to id-keyed; rename the dirs before
    // adapters install watches or inspect any native conversation store.
    reconcileProfileDirs(profiles.list(), paths);
    const share = new ConversationShare({
      accounts,
      adapters,
      paths,
      mutex: new KeyedMutex(),
      events,
    });
    const service = new SessionService({
      storage,
      storagePaths,
      profiles,
      accounts,
      repos,
      projects,
      sessions,
      conversations,
      events,
      worktrees,
      ptys,
      adapters,
      logs,
      onboarding,
      share,
      shellHooks,
      statusQuietMs: opts.statusQuietMs,
    });
    const compilation = new CompilationService(
      [
        latex,
        ...createCodeProviders({
          sessions,
          repos,
          notebooks,
          launchTerminal: createCodeTerminalLauncher({ sessions, repos, projects, service, ptys }),
        }),
      ],
      { settings: compilationSettings, projects, profiles },
    );
    failedStartup.push(() => compilation.dispose());
    const puddlang = new PuddlangService(new PuddlangStore(db), {
      profiles,
      accounts,
      projects,
      repos,
      adapters,
      service,
      worktrees,
    });
    failedStartup.push(() => puddlang.dispose());
    const stopPush = subscribePushNotifications(paths.home, service, {
      profiles,
      projects,
      sessions,
    });
    failedStartup.push(stopPush);
    const catalogue = new ConversationCatalogue({
      accounts,
      conversations,
      projects,
      repos,
      sessions,
      adapters,
      worktrees,
    });

    failedStartup.push(() => {
      service.beginShutdown();
      catalogue.dispose();
    });

    // Stored logged-in flags can lie (keychain-bound creds die with a path
    // change) — re-verify each account in the background so badges are honest.
    void Promise.allSettled(
      accounts.list().map(async (account) => {
        try {
          const adapter = adapters.get(account.agent_type);
          adapter.reconcileConfigDir?.(account); // idempotent upkeep (e.g. status line)
          // An uninstalled agent answers "logged out" to every probe; booting
          // without it on PATH must not clear every stored flag (SPEC §5).
          if (adapter.checkLoggedIn && isBinaryAvailable(adapter)) {
            accounts.setLoggedIn(account.id, await adapter.checkLoggedIn(account));
          }
        } catch {
          // Unknown adapter or probe failure: leave the stored flag alone.
        }
      }),
    );

    // Repair the shared conversation store's symlinks (missing/dangling) so
    // every account of a profile can still resolve its adopted conversations.
    void share
      .reconcile()
      .catch((e) => console.warn(`conversation reconcile failed: ${e.message}`));

    const sweptStates = profileStates.gc(config.uiStateRetentionDays);
    if (sweptStates > 0) console.log(`ui-state gc: ${sweptStates} stale row(s) removed`);

    const reconciled = reconcilePass({ sessions, events, projects, onboarding });
    if (reconciled.interrupted.length > 0) {
      console.log(`reconcile: ${reconciled.interrupted.length} session(s) marked interrupted`);
    }

    // Periodic fetch for repos with at least one non-archived session (SPEC §4).
    const fetchTimer = setInterval(
      () => {
        for (const repo of repos.list()) {
          if (!repo.fetch_enabled) continue;
          if (sessions.listActiveByRepo(repo.id).length === 0) continue;
          void worktrees
            .fetchRepo(repo)
            .catch((e) => console.warn(`periodic fetch failed for ${repo.path}: ${e.message}`));
        }
      },
      config.fetchIntervalMinutes * 60 * 1000,
    );
    fetchTimer.unref();

    const tracker = new ProxySocketTracker();
    const gateway = new WsGateway({
      profileAccess: new ProfileAccess({ profiles, projects, sessions }),
      authority,
      ptys,
      logs,
      service,
      catalogue,
      theme: terminalTheme,
    });
    // Login verification lands after the login PTY exits, when no request is in
    // flight to carry it — the push is what turns the accounts UI green (15.1).
    accounts.onLoggedInChanged = (account) => gateway.accountChanged(account);
    const app = buildApp({
      version: opts.version ?? '0.0.0',
      authority,
      api: {
        storage,
        paths,
        profiles,
        accounts,
        repos,
        projects,
        profileStates,
        removals,
        scratchpad,
        layouts,
        sessions,
        catalogue,
        adapters,
        ptys,
        worktrees,
        service,
        share,
        scanner,
        tracker,
        compilation,
        notebooks,
        latex,
        puddlang,
        onboarding,
      },
      ws: { gateway, upgradeWebSocket },
    });

    const wss = new WebSocketServer({ noServer: true });
    // createAdaptorServer builds the server WITHOUT listening, so we own the bind
    // and can fall back off a busy port (listenWithFallback) instead of crashing.
    const server: ServerType = createAdaptorServer({
      fetch: app.fetch,
      websocket: { server: wss },
    });
    failedStartup.push(() => {
      clearInterval(fetchTimer);
      wss.close();
      server.close();
      if ('closeAllConnections' in server) server.closeAllConnections();
    });
    // Windows: every PTY from here on is put in its job before it can start anything.
    if (platform === 'win32') await ptys.prepare();
    const port = await listenWithFallback(server, opts.port ?? config.port, '127.0.0.1', platform);
    // Record where we actually bound so clients (and a returning `puddle launch`)
    // can find us even when the preferred port was taken.
    controlInfo = {
      port,
      version: { version: opts.version ?? '0.0.0', protocol: PROTOCOL_VERSION },
    };
    writeRuntime(paths, { port, pid: process.pid });
    // Agent spawns from here on carry the /agent-signal env pair (SPEC §4).
    service.setSignalPort(port);

    // Auto-resume is ON by default (SPEC §4; flipped 2026-08-09) — a daemon
    // restart brings interrupted sessions straight back; any that fail surface
    // in the UI for one-click resume. Runs AFTER the bind on purpose, so
    // auto-resumed agents get the signal env too.
    if (config.autoResume) {
      for (const id of reconciled.interrupted) {
        await service
          .resume(id)
          .catch((e) => console.warn(`auto-resume ${id} failed: ${e.message}`));
      }
    }

    // Register the tier-2 proxy's raw WebSocket upgrade listener AFTER serve() so
    // it becomes the SECOND 'upgrade' listener — see attachProxyUpgrade for why
    // that ordering is load-bearing. /ws stays with @hono/node-server's own listener.
    const detachProxy = attachProxyUpgrade(server as import('node:http').Server, {
      sessions,
      scanner,
      authority,
      tracker,
    });

    const retention = new LogRetention(() => {
      const current = readConfig(paths);
      return {
        logsDir: paths.logsDir,
        retentionDays: current.logRetentionDays,
        // The live LogStore keeps its boot-time replay window until restart.
        replayBytes: Math.max(config.replayBytes, current.replayBytes),
        isBusy: (stream, term) => ptys.has(stream, term) || logs.isOpen(stream, term),
      };
    });
    retention.start();
    failedStartup.push(() => retention.dispose());

    let stopping: Promise<void> | null = null;
    const stop = async () => {
      await retention.dispose();
      storage.dispose();
      await puddlang.dispose();
      stopPush();
      controlInfo = null;
      authority.dispose();
      // The control pipe is Windows' single-instance lock: hold it until the
      // database is closed, so "pipe gone" means "daemon gone". Without
      // controlInfo it answers every request with `unavailable` meanwhile.
      if (platform !== 'win32') await closeControl();
      clearInterval(fetchTimer);
      catalogue.dispose();
      compilation.dispose();
      await notebooks.dispose();
      onboarding.dispose();
      // Freeze session rows at their live statuses (reconcile → interrupted),
      // then wait for PTY exits so nothing touches the db after close.
      service.beginShutdown();
      ptys.killAll();
      const deadline = Date.now() + 3000;
      while (ptys.liveCount() > 0) {
        if (Date.now() > deadline) {
          if (platform === 'win32') {
            // Windows has no hang-up: a PTY counts as live until what its
            // root left running is stopped (or its deadline), so this waits
            // for that too.
            await stopRemainingConptys(ptys);
            break;
          }
          ptys.killAll(undefined, 'SIGKILL');
          await new Promise((r) => setTimeout(r, 200));
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      // Nothing a PTY started may outlive the daemon: wait for the process
      // table's passes that outlasted their PTYs' deadlines.
      if (platform === 'win32') await ptys.settled(SETTLE_MS);
      await ptys.closeTerminalStates();
      logs.closeAll();
      if (platform === 'win32') clearPtyRoots(ptyRootsFile(paths.home));
      // Proxied WebSocket sockets (client + outbound upstream) are not covered
      // by closeAllConnections and would hold the process open — detach the
      // listener and tear the pairs down before closing the server.
      detachProxy();
      tracker.destroyAll();
      await new Promise<void>((resolve) => {
        wss.close();
        server.close(() => resolve());
        // Idle keep-alive and WS sockets would hold close() open forever.
        if ('closeAllConnections' in server) {
          (server as import('node:http').Server).closeAllConnections();
        }
      });
      // After the socket is closed, not before: the file's presence means "up",
      // so a reader mid-shutdown probes a dead port (→ restart), never a live
      // one it then mis-trusts.
      clearRuntime(paths);
      db.close();
      if (platform === 'win32') await closeControl();
    };
    stopDaemon = () => (stopping ??= stop());
    if (shutdownRequested) requestShutdown!();

    return {
      port,
      authority,
      paths,
      service,
      stop: stopDaemon,
    };
  } catch (err) {
    controlInfo = null;
    authority.dispose();
    for (const cleanup of failedStartup.reverse()) {
      try {
        await cleanup();
      } catch {
        /* Preserve the startup failure. */
      }
    }
    throw err;
  }
}

/**
 * Bound on a Windows shutdown waiting for the process table's passes that
 * outlasted their PTYs' deadlines (a query times out after 8 s). Whatever
 * is still in a PTY's job ends with the daemon anyway.
 */
const SETTLE_MS = 10_000;

/**
 * Windows shutdown, once the PTYs' consoles have had their time to close:
 * SIGKILL ends each remaining PTY's job, or stops its process tree
 * (PtyManager), then this waits until every PTY has reported its exit,
 * which it does once what its root left running is stopped too, or at its
 * deadline.
 */
export async function stopRemainingConptys(
  ptys: Pick<PtyManager, 'killAll' | 'liveCount'>,
  boundMs = 15_000,
): Promise<void> {
  ptys.killAll(undefined, 'SIGKILL');
  const deadline = Date.now() + boundMs;
  while (ptys.liveCount() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** After a Windows `killAll()`: the consoles' time to close, then stopRemainingConptys. */
async function settleConptys(ptys: Pick<PtyManager, 'killAll' | 'liveCount'>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (ptys.liveCount() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (ptys.liveCount() > 0) await stopRemainingConptys(ptys);
}

/**
 * Bind `server` to `preferredPort`, falling back to an OS-assigned free port if
 * it is already in use — the bind IS the selection, so there is no check-then-
 * bind race. Only EADDRINUSE falls back: EACCES (a misconfigured privileged
 * port) and every other error propagate, since those are configuration faults,
 * not contention. A `preferredPort` of 0 already means "any free port".
 * Windows has no privileged ports: there EACCES means a port inside a range
 * Hyper-V, WSL or Docker reserved, which is contention too.
 */
export function listenWithFallback(
  server: ServerType,
  preferredPort: number,
  hostname: string,
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  const contended = new Set(platform === 'win32' ? ['EADDRINUSE', 'EACCES'] : ['EADDRINUSE']);
  return new Promise((resolve, reject) => {
    let triedFallback = false;
    const onError = (err: NodeJS.ErrnoException) => {
      if (contended.has(err.code ?? '') && !triedFallback && preferredPort !== 0) {
        triedFallback = true;
        console.warn(
          err.code === 'EADDRINUSE'
            ? `port ${preferredPort} is in use — binding a free port instead`
            : `port ${preferredPort} is reserved by Windows — binding a free port instead`,
        );
        server.listen(0, hostname); // retry; onError stays attached for a second failure
        return;
      }
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : preferredPort);
    };
    server.on('error', onError);
    server.once('listening', onListening);
    server.listen(preferredPort, hostname);
  });
}
