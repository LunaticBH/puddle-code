import type { VersionResponse } from '@puddle/shared';
import {
  installDaemon,
  installedVersion,
  type BootstrapOptions,
} from '../installation/bootstrap.js';
import { runHandshake, type ConfirmDaemonUpgrade } from './handshake.js';
import { acquireAuthority, type HostConnection } from '../auth/connection-authority.js';
import { inspectHost } from '../auth/control-channel.js';
import { sleep } from '../transport/net.js';
import { hostPaths } from '../paths.js';
import type { Transport } from '../transport/transport.js';
import { CliError, type CliEvent, type Logger, silentLogger } from '../types.js';

/**
 * A running cockpit: the UI server (and tunnel, in SSH mode) behind one
 * handle. This is the seam a future desktop shell builds on — stop() closes
 * only client-side pieces; the daemon and its agents keep running.
 */
export interface RunningCockpit {
  origin: string;
  /** Mint a single-use browser invitation. Never persist the returned URL. */
  createInvitation(): string;
  launcherPath: string;
  /** The UI server's per-instance identity (see UiServer.nonce). */
  nonce: string;
  daemon: VersionResponse;
  /** Whether puddled outlives this cockpit or is held by its SSH connection. */
  daemonLifetime: 'persistent' | 'cockpit';
  onEvent(cb: (e: CliEvent) => void): () => void;
  stop(): Promise<void>;
}

export interface DaemonLease {
  /** Re-establish the attached daemon after the SSH connection itself recovers. */
  ensureRunning(): Promise<void>;
  /** Cleanly stop the daemon before closing the cockpit's SSH connection. */
  stop(): Promise<void>;
}

export interface DaemonEndpoint {
  /** The daemon's own port on its host (not a tunnel port). */
  port: number;
  authority: HostConnection;
  /** True when this call installed or restarted the daemon. */
  bootstrapped: boolean;
  /** Persistent supervisor, or an SSH channel owned by this cockpit. */
  daemonLifetime: 'persistent' | 'cockpit';
  /** Present only when daemonLifetime is `cockpit`. */
  lease?: DaemonLease;
}

/**
 * Make sure a daemon is installed and answering on its host, installing or
 * restarting via the embedded install.sh when needed; returns its port and
 * connection authority. Legacy inspection stays on the host because the
 * tunnel may not exist and the master credential must never leave it.
 */
export async function ensureDaemon(
  transport: Transport,
  opts: BootstrapOptions & {
    logger?: Logger;
    /** SSH-only recovery for hosts that reap a detached nohup child. */
    attachedFallback?: () => Promise<DaemonEndpoint>;
    /** Test seam; normal launches use five seconds with a fallback, twenty without. */
    startTimeoutMs?: number;
    noUpgrade?: boolean;
    confirmDaemonUpgrade?: ConfirmDaemonUpgrade;
  },
): Promise<DaemonEndpoint> {
  const logger = opts.logger ?? silentLogger;
  const startTimeoutMs =
    opts.startTimeoutMs ?? (opts.attachedFallback === undefined ? 20_000 : 5_000);
  let mismatch: CliError | undefined;
  try {
    const authority = await acquireAuthority(transport);
    return { port: authority.port, authority, bootstrapped: false, daemonLifetime: 'persistent' };
  } catch (err) {
    if (err instanceof CliError && err.code === 'protocol_mismatch') mismatch = err;
  }
  const inspection = await inspectHost(transport).catch((err: unknown) => {
    // A known, live mismatch must never become a blind bootstrap when inspection fails.
    if (err instanceof CliError || mismatch) throw err;
    return null;
  });
  if (!inspection && mismatch) throw mismatch;
  const install = async () => {
    await installDaemon(transport, opts);
    return waitAfterInstall(transport, opts, logger, true, startTimeoutMs);
  };
  if (inspection) {
    let replacement: DaemonEndpoint | undefined;
    try {
      await runHandshake({
        host: transport.label,
        inspection,
        noUpgrade: opts.noUpgrade,
        confirmDaemonUpgrade: opts.confirmDaemonUpgrade,
        reinspect: () => inspectHost(transport),
        logger,
        upgradeDaemon: async () => {
          replacement = await install();
          return replacement.authority.version!;
        },
      });
      if (replacement) return replacement;
      // Inspection found a compatible host. Retry its authority, without reinstalling it.
      const authority = await acquireAuthority(transport);
      return { port: authority.port, authority, bootstrapped: false, daemonLifetime: 'persistent' };
    } catch (err) {
      replacement?.authority.close();
      await replacement?.lease?.stop();
      throw err;
    }
  }
  if ((await installedVersion(transport)) !== null) {
    logger.info(`restarting puddled on ${transport.label}`);
  }
  return install();
}

async function waitAfterInstall(
  transport: Transport,
  opts: { attachedFallback?: () => Promise<DaemonEndpoint> },
  logger: Logger,
  bootstrapped: boolean,
  timeoutMs: number,
): Promise<DaemonEndpoint> {
  try {
    const started = await waitForStartedDaemon(transport, timeoutMs);
    return { ...started, bootstrapped, daemonLifetime: 'persistent' };
  } catch (err) {
    if (
      !(err instanceof CliError) ||
      err.code !== 'daemon_start_timeout' ||
      opts.attachedFallback === undefined ||
      !(await detachedNohupWasReaped(transport))
    ) {
      throw err;
    }
    logger.warn(
      `puddled could not stay detached on ${transport.label} — keeping it attached to this cockpit; ` +
        'session state stays on disk and can resume on the next launch',
    );
    return opts.attachedFallback();
  }
}

/**
 * A fallback is safe only when install.sh explicitly selected nohup and its
 * recorded child is no longer alive. A live-but-unhealthy process or a real
 * supervisor must be diagnosed, never joined by a competing daemon.
 */
async function detachedNohupWasReaped(transport: Transport): Promise<boolean> {
  if (transport.kind !== 'ssh') return false;
  const supervisor = (await transport.readFile(hostPaths.supervisor))?.trim();
  if (supervisor !== 'nohup') return false;
  const rawPid = (await transport.readFile(hostPaths.pid))?.trim() ?? '';
  if (!/^[1-9][0-9]*$/.test(rawPid)) return true;
  const probe = await transport.exec(`kill -0 ${rawPid}`, { timeoutMs: 5000 });
  return probe.code !== 0;
}

/** Wait for authenticated host control readiness, never a TCP/401 probe. */
export async function waitForStartedDaemon(
  transport: Transport,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ port: number; authority: HostConnection }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal?.aborted) {
    try {
      const authority = await acquireAuthority(transport);
      if (signal?.aborted) {
        authority.close();
        throw startTimeout(transport);
      }
      return { port: authority.port, authority };
    } catch (err) {
      if (err instanceof CliError && err.code === 'protocol_mismatch') throw err;
    }
    await sleep(500);
  }
  throw startTimeout(transport);
}

function startTimeout(transport: Transport): CliError {
  return new CliError(
    'daemon_start_timeout',
    `puddled did not come up on ${transport.label}`,
    transport.kind === 'ssh'
      ? `inspect it with: puddle logs ${transport.label}`
      : 'inspect it with: puddle logs',
  );
}
