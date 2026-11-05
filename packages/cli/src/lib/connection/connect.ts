import { join } from 'node:path';
import { AttachedDaemon } from './attached-daemon.js';
import { WindowsAttachedDaemon } from './windows-attached-daemon.js';
import { DaemonClient, readDaemonPort } from './daemon-client.js';
import { ensureDaemon, type RunningCockpit } from './cockpit.js';
import { verifyDaemonVersion, type ConfirmDaemonUpgrade } from './handshake.js';
import { waitForHttp } from '../transport/net.js';
import { clientHome } from '../paths.js';
import { startUiServer } from '../serve/ui-server.js';
import { RemoteAccessControl } from '../host/remote-access.js';
import { remoteWindowsHost } from '../host/windows-remote-host.js';
import { openCallbackForward, openTunnel } from '../transport/tunnel.js';
import { LocalTransport } from '../transport/local.js';
import { SshTransport } from '../transport/ssh.js';
import type { CliEvent, Logger } from '../types.js';
import { silentLogger } from '../types.js';

/**
 * Codex's OAuth login server: a FIXED port baked into its registered
 * `http://localhost:1455/...` redirect URI, so the IdP sends the CLIENT
 * browser there — only a client-side forward can complete it remotely. The
 * other agents need nothing here: claude-code's callback is hosted
 * (platform.claude.com), gemini-cli binds a random loopback port that cannot
 * be forwarded ahead of time (its picker offers API-key auth instead), and
 * opencode takes pasted keys.
 */
const CODEX_OAUTH_PORT = 1455;

export interface ConnectOptions {
  host: string;
  /** UI port; auto-picks the next free one when omitted (7433 default). */
  port?: number;
  /** Preferred (non-strict) UI port — where the probe starts. `refresh` passes
   *  the old cockpit's port so an open browser tab keeps its origin. */
  preferPort?: number;
  /** Daemon port on the host, when its config.json cannot be trusted. */
  remotePort?: number;
  /** Dev override: install the daemon from this local tarball. */
  tarball?: string;
  assetsDir: string;
  noUpgrade?: boolean;
  confirmDaemonUpgrade?: ConfirmDaemonUpgrade;
  logger?: Logger;
  /** POST /cockpit/refresh (the UI's refresh button) invokes this — the CLI
   *  layer supplies the process-spawning behaviour; lib stays process-free. */
  onRefreshRequest?: (refreshId: string) => void;
  /** A launcher `shutdown` request (Windows `puddle kill`); requires onRefreshRequest. */
  onShutdownRequest?: () => void;
  refreshId?: string;
  /** Test seams. */
  sshBinary?: string;
  scpBinary?: string;
  platform?: NodeJS.Platform;
  /** OpenSSH askpass executable for a graphical embedder with no terminal. */
  sshAskpassProgram?: string;
  /** Never prompt: a Windows background cockpit, with no terminal and no ControlMaster. */
  sshBatchMode?: boolean;
  /** The host's platform as the launcher found it (a background cockpit's handover). */
  remotePlatform?: 'win32';
  /** Test seam: the PUDDLE_HOME a Windows host uses for this connection. */
  sshWindowsHome?: string;
}

/**
 * SSH mode (SPEC §10): master connection → bootstrap/upgrade the daemon →
 * tunnel → verify the API → serve the UI locally with /api + /ws proxied through
 * the tunnel. Ctrl-C (the caller's stop()) closes the tunnel and UI server;
 * supervised daemons keep running, while an attached fallback shuts down
 * cleanly and resumes its interrupted sessions on the next launch.
 */
export async function connectRemote(opts: ConnectOptions): Promise<RunningCockpit> {
  const logger = opts.logger ?? silentLogger;
  const platform = opts.platform ?? process.platform;
  const ssh = new SshTransport(opts.host, {
    sshBinary: opts.sshBinary,
    scpBinary: opts.scpBinary,
    platform,
    askpassProgram: opts.sshAskpassProgram,
    ...(opts.sshBatchMode ? { batchMode: true } : {}),
    ...(opts.remotePlatform ? { remotePlatform: opts.remotePlatform } : {}),
    ...(opts.sshWindowsHome !== undefined ? { windowsHome: opts.sshWindowsHome } : {}),
  });
  if (platform === 'win32' && !opts.sshBatchMode) {
    logger.warn(
      'Windows OpenSSH cannot share a connection; you may be asked to authenticate more than once. ' +
        'An SSH key (ssh-copy-id) avoids the prompts.',
    );
  }
  await ssh.open();

  let tunnelResource: Awaited<ReturnType<typeof openTunnel>> | undefined;
  let oauthForwardResource: Awaited<ReturnType<typeof openCallbackForward>> | undefined;
  let uiResource: Awaited<ReturnType<typeof startUiServer>> | undefined;
  let endpointResource: Awaited<ReturnType<typeof ensureDaemon>> | undefined;

  try {
    const bootstrap = {
      tarball: opts.tarball,
      logger,
      noUpgrade: opts.noUpgrade,
      confirmDaemonUpgrade: opts.confirmDaemonUpgrade,
    };
    const attachedDaemon = new AttachedDaemon(ssh, logger);
    // A Windows host may be recognised only during ensureDaemon (Git Bash default shells).
    const attachedWindowsDaemon = new WindowsAttachedDaemon(ssh, logger);
    const endpoint = await ensureDaemon(ssh, {
      ...bootstrap,
      attachedFallback: () =>
        ssh.remotePlatform === 'win32' ? attachedWindowsDaemon.start() : attachedDaemon.start(),
    });
    endpointResource = endpoint;
    // A supervisor an elevated SSH session started through WMI stays elevated.
    if (ssh.remotePlatform === 'win32') await remoteWindowsHost(ssh).warnElevated(logger);
    let remotePort = opts.remotePort ?? endpoint.port;
    const eventCbs = new Set<(e: CliEvent) => void>();

    // Readiness is the daemon answering /api/version through the forward — any
    // HTTP status proves the byte path (the authenticated handshake follows).
    const tunnel = await openTunnel(ssh, remotePort, {
      sshBinary: opts.sshBinary,
      logger,
      ready: async (localPort) => {
        await endpoint.lease?.ensureRunning();
        return waitForHttp(`http://127.0.0.1:${localPort}/api/version`, 8000);
      },
    });
    tunnelResource = tunnel;
    const client = new DaemonClient(tunnel.localPort, endpoint.authority);
    const watchTunnel = (active: typeof tunnel) => {
      active.onPortChange((port) => {
        if (tunnelResource !== active) return;
        client.setPort(port);
        uiResource?.setTarget({ host: '127.0.0.1', port });
      });
      active.onAvailability((available) => {
        if (tunnelResource === active) endpoint.authority.setTransportAvailable(available);
      });
      active.onEvent((e) => {
        if (tunnelResource !== active) return;
        if (e.t === 'tunnel-down') logger.warn(`tunnel to ${opts.host} lost — reconnecting…`);
        if (e.t === 'tunnel-up') logger.info('tunnel restored');
        eventCbs.forEach((cb) => cb(e));
      });
    };
    watchTunnel(tunnel);

    // Carry the client's localhost:1455 to the host for the cockpit's lifetime,
    // so the login URL a remote codex prints works AS PRINTED — clicked or
    // pasted — and the IdP's callback to the client lands on codex's login
    // server. Best-effort by design; the cockpit works fully without it.
    const oauthForward = await openCallbackForward(ssh, CODEX_OAUTH_PORT, {
      sshBinary: opts.sshBinary,
      logger,
    });
    oauthForwardResource = oauthForward;

    const daemon = verifyDaemonVersion(await client.version());

    // Never squat the port a local `puddle launch` will probe for its own daemon,
    // or that probe would find this cockpit's proxy answering for a different
    // (remote) daemon and abort with a port conflict. That target is the LOCAL
    // daemon's configured port — read from this machine's config.json the same
    // way `start` does — not `endpoint.port`, which is the remote daemon's and
    // only coincides when the remote uses the default 7434.
    const avoidPort = await readDaemonPort(new LocalTransport());

    endpoint.authority.setVerifier(async () => {
      const generation = endpoint.authority.generation;
      const nextPort = opts.remotePort ?? endpoint.authority.port;
      if (nextPort !== remotePort) {
        const replacement = await openTunnel(ssh, nextPort, {
          sshBinary: opts.sshBinary,
          logger,
          ready: (port) => waitForHttp(`http://127.0.0.1:${port}/api/version`, 8000),
        });
        if (endpoint.authority.generation !== generation) {
          await replacement.close();
          throw new Error('Connection generation changed during recovery');
        }
        const previous = tunnelResource;
        tunnelResource = replacement;
        remotePort = nextPort;
        client.setPort(replacement.localPort);
        uiResource?.setTarget({ host: '127.0.0.1', port: replacement.localPort });
        watchTunnel(replacement);
        await previous?.close();
      }
      verifyDaemonVersion(await client.version());
    });
    const ui = await startUiServer({
      authority: endpoint.authority,
      identity: opts.host,
      refreshId: opts.refreshId,
      assetsDir: opts.assetsDir,
      port: opts.port ?? opts.preferPort,
      strictPort: opts.port !== undefined, // a preferred port stays non-strict
      avoidPort,
      target: { host: '127.0.0.1', port: tunnel.localPort },
      ...(opts.onRefreshRequest !== undefined
        ? {
            control: {
              onRefresh: opts.onRefreshRequest,
              ...(opts.onShutdownRequest ? { onShutdown: opts.onShutdownRequest } : {}),
            },
          }
        : {}),
      // The store lives on the CLIENT machine — every cockpit here shares it,
      // whichever remote daemon each one drives.
      localSync: { file: join(clientHome(), 'local-sync.json') },
      remoteAccess: new RemoteAccessControl(ssh),
    });
    uiResource = ui;

    return {
      origin: ui.origin,
      createInvitation: ui.createInvitation,
      launcherPath: ui.launcherPath,
      nonce: ui.nonce,
      daemon,
      daemonLifetime: endpoint.daemonLifetime,
      onEvent(cb) {
        eventCbs.add(cb);
        return () => eventCbs.delete(cb);
      },
      async stop() {
        await closeRemoteResources(ui, oauthForward, endpoint, tunnelResource, ssh);
      },
    };
  } catch (err) {
    try {
      await closeRemoteResources(
        uiResource,
        oauthForwardResource,
        endpointResource,
        tunnelResource,
        ssh,
      );
    } catch {
      // Preserve the setup failure; cleanup errors are secondary here.
    }
    throw err;
  }
}

async function closeRemoteResources(
  ui: Awaited<ReturnType<typeof startUiServer>> | undefined,
  oauthForward: Awaited<ReturnType<typeof openCallbackForward>> | undefined,
  endpoint: Awaited<ReturnType<typeof ensureDaemon>> | undefined,
  tunnel: Awaited<ReturnType<typeof openTunnel>> | undefined,
  ssh: SshTransport,
): Promise<void> {
  const actions: Array<() => void | Promise<void>> = [
    () => ui?.close(),
    () => oauthForward?.(),
    () => endpoint?.authority.close(),
    () => endpoint?.lease?.stop(),
    () => tunnel?.close(),
    () => ssh.dispose(),
  ];
  let firstError: unknown;
  for (const action of actions) {
    try {
      await action();
    } catch (err) {
      if (firstError === undefined) firstError = err;
    }
  }
  if (firstError !== undefined) throw firstError;
}
