import { join } from 'node:path';
import { DaemonClient } from './daemon-client.js';
import { ensureDaemon, type RunningCockpit } from './cockpit.js';
import { verifyDaemonVersion, type ConfirmDaemonUpgrade } from './handshake.js';
import { clientHome } from '../paths.js';
import { startUiServer } from '../serve/ui-server.js';
import { LocalTransport } from '../transport/local.js';
import type { CliEvent, Logger } from '../types.js';
import { silentLogger } from '../types.js';
import { RemoteAccessControl } from '../host/remote-access.js';
import { localFileManager } from '../host/file-manager.js';

export interface StartOptions {
  /** UI port; auto-picks the next free one when omitted (7433 default). */
  port?: number;
  /** Preferred (non-strict) UI port — where the probe starts. `refresh` passes
   *  the old cockpit's port so an open browser tab keeps its origin. */
  preferPort?: number;
  /** Dev override: install the daemon from this local tarball. */
  tarball?: string;
  /** Directory holding the built web UI. */
  assetsDir: string;
  noUpgrade?: boolean;
  confirmDaemonUpgrade?: ConfirmDaemonUpgrade;
  logger?: Logger;
  /** POST /cockpit/refresh (the UI's refresh button) invokes this — the CLI
   *  layer supplies the process-spawning behaviour; lib stays process-free. */
  onRefreshRequest?: (refreshId: string) => void;
  refreshId?: string;
}

/**
 * Local mode (SPEC §10): ensure puddled runs on THIS machine, then serve the
 * UI with /api + /ws proxied to it — the same serve path as remote mode, no
 * SSH and no tunnel.
 */
export async function startLocal(opts: StartOptions): Promise<RunningCockpit> {
  const logger = opts.logger ?? silentLogger;
  const transport = new LocalTransport();
  const bootstrap = {
    tarball: opts.tarball,
    logger,
    noUpgrade: opts.noUpgrade,
    confirmDaemonUpgrade: opts.confirmDaemonUpgrade,
  };

  let endpoint: Awaited<ReturnType<typeof ensureDaemon>> | undefined;
  try {
    endpoint = await ensureDaemon(transport, bootstrap);
    const authority = endpoint.authority;
    const client = new DaemonClient(endpoint.port, authority);
    const daemon = verifyDaemonVersion(await client.version());

    let currentUi: Awaited<ReturnType<typeof startUiServer>> | undefined = undefined;
    authority.setVerifier(async () => {
      client.setPort(authority.port);
      verifyDaemonVersion(await client.version());
      currentUi?.setTarget({ host: '127.0.0.1', port: authority.port });
    });
    const ui = await startUiServer({
      authority,
      identity: 'local',
      refreshId: opts.refreshId,
      assetsDir: opts.assetsDir,
      port: opts.port ?? opts.preferPort,
      strictPort: opts.port !== undefined, // a preferred port stays non-strict
      avoidPort: endpoint.port, // never squat the daemon's own port
      target: { host: '127.0.0.1', port: endpoint.port },
      ...(opts.onRefreshRequest !== undefined
        ? { control: { onRefresh: opts.onRefreshRequest } }
        : {}),
      localSync: { file: join(clientHome(), 'local-sync.json') },
      fileManager: localFileManager(),
      remoteAccess: new RemoteAccessControl(transport),
    });
    currentUi = ui;

    const eventCbs = new Set<(e: CliEvent) => void>();
    return {
      origin: ui.origin,
      createInvitation: ui.createInvitation,
      launcherPath: ui.launcherPath,
      nonce: ui.nonce,
      daemon,
      daemonLifetime: 'persistent',
      onEvent(cb) {
        eventCbs.add(cb);
        return () => eventCbs.delete(cb);
      },
      async stop() {
        await ui.close();
        authority.close();
        transport.dispose();
      },
    };
  } catch (err) {
    endpoint?.authority.close();
    transport.dispose();
    throw err;
  }
}
