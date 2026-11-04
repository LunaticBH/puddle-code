import type { VersionResponse } from '@puddle/shared';
import {
  installDaemon,
  installedVersion,
  type BootstrapOptions,
} from '../installation/bootstrap.js';
import { runHandshake, type ConfirmDaemonUpgrade } from './handshake.js';
import { acquireAuthority, type HostConnection } from '../auth/connection-authority.js';
import { inspectHost } from '../auth/control-channel.js';
import { controlPipePresent } from '../installation/windows-daemon.js';
import { sleep } from '../transport/net.js';
import { clientHome, hostPaths } from '../paths.js';
import { isLocalWindows } from '../transport/local.js';
import type { Transport } from '../transport/transport.js';
import { CliError, type CliEvent, type Logger, silentLogger } from '../types.js';
import { pinnedDaemonVersion } from '../version.js';

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
  const localWindows = isLocalWindows(transport);
  // Defender scans a freshly unpacked Windows runtime on its first start.
  const startTimeoutMs =
    opts.startTimeoutMs ??
    (opts.attachedFallback !== undefined ? 5_000 : localWindows ? 60_000 : 20_000);
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
  const install = async (replaceRunning = true, version?: string) => {
    await installDaemon(transport, {
      ...opts,
      ...(version !== undefined ? { version } : {}),
      ...(replaceRunning ? {} : { replaceRunning }),
    });
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
  if (localWindows) {
    return startLocalWindows(transport, logger, startTimeoutMs, install, {
      // An explicit release or archive is what the caller asked for.
      keepInstalled: opts.version === undefined && opts.tarball === undefined,
      // Pinned to this launcher's own release (the default), so it never comes back here.
      retry: () => ensureDaemon(transport, { ...opts, version: pinnedDaemonVersion() }),
    });
  }
  if ((await installedVersion(transport)) !== null) {
    logger.info(`restarting puddled on ${transport.label}`);
  }
  return install();
}

/**
 * Windows never competes with a daemon that holds the home's control pipe:
 * one that is starting, or too busy to answer, is waited for rather than
 * replaced (an ambiguous probe is not an absent daemon). Otherwise install
 * or start it, leaving alone one that another launcher, or the home's
 * supervisor, starts meanwhile.
 *
 * With nothing running (the logon task did not run, or the daemon was
 * stopped), the installed `bin\current` is started through the home's
 * supervisor (its scheduled task, else WMI), as a POSIX supervisor restarts
 * it: version changes are the handshake's and `puddle upgrade`'s, never a
 * side effect of which launcher happens to start first. Only when that tree
 * cannot run is this launcher's own release installed; one whose protocol
 * is incompatible is handed back to the handshake through `retry`.
 */
async function startLocalWindows(
  transport: Transport,
  logger: Logger,
  timeoutMs: number,
  install: (replaceRunning: boolean, version?: string) => Promise<DaemonEndpoint>,
  opts: { keepInstalled: boolean; retry: () => Promise<DaemonEndpoint> },
): Promise<DaemonEndpoint> {
  if (await controlPipePresent(clientHome())) {
    logger.info('puddled is starting on this machine — waiting for it');
    try {
      const started = await waitForStartedDaemon(transport, timeoutMs);
      return { ...started, bootstrapped: false, daemonLifetime: 'persistent' };
    } catch (err) {
      if (!(err instanceof CliError) || err.code !== 'daemon_start_timeout') throw err;
      throw new CliError(
        'daemon_unreachable',
        'puddled holds its control pipe on this machine but does not answer',
        'see its output with: puddle logs — restart it with: puddle upgrade daemon',
      );
    }
  }
  const installed = await installedVersion(transport);
  if (installed === null) return install(false);
  logger.info('starting puddled on this machine');
  if (!opts.keepInstalled) return install(false);
  try {
    // An installed tree is smoke-tested and started in place: no download.
    return await install(false, installed);
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    if (err.code === 'protocol_mismatch') return opts.retry();
    if (err.code !== 'not_installed') throw err;
    logger.warn(`puddled ${installed} cannot start (${err.message}) — installing this release`);
  }
  return install(false);
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
