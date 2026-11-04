import { readCurrentVersion } from '../installation/current-link.js';
import {
  runWindowsConnector,
  windowsConnectorInstalled,
  type ConnectorRun,
  type WindowsConnectorRunner,
} from '../installation/windows-connector.js';
import { controlPipePresent } from '../installation/windows-daemon.js';
import { installWindowsDaemon, windowsInstalledVersion } from '../installation/windows-install.js';
import { removeWindowsDaemon, sweepWindowsWorktrees } from '../installation/windows-remove.js';
import type { LogsOptions } from '../logs.js';
import { clientHome } from '../paths.js';
import { remoteWindows } from '../transport/host-platform.js';
import { isLocalWindows } from '../transport/local.js';
import type { Transport } from '../transport/transport.js';
import type { Logger } from '../types.js';
import { showWindowsLogs } from '../windows-logs.js';
import { remoteWindowsHost } from './windows-remote-host.js';

/**
 * Every host operation a Windows host needs, whichever side of an SSH
 * connection it is on (docs/windows.md): in process for this machine, and
 * through the host helper for a Windows SSH host. POSIX hosts get null, so
 * their code paths, and every command they receive, stay as they were.
 */
export interface WindowsHostOps {
  /** The installed release, when its runtime is this machine's build. */
  installedVersion(): Promise<string | null>;
  /** Whether a daemon may hold the home's control pipe (one starting, or too busy to answer). */
  pipePresent(): Promise<boolean>;
  install(opts: WindowsInstallRequest): Promise<void>;
  sweep(): Promise<string[]>;
  remove(opts: { purge: boolean; logger?: Logger }): Promise<void>;
  logs(opts: LogsOptions): Promise<void>;
  /** Whether the installed release ships the connector, and which release that is. */
  connectorInstalled(): Promise<{ installed: boolean; version: string | null }>;
  connector(
    args: readonly string[],
    opts?: { stdin?: string; timeoutMs?: number },
  ): Promise<ConnectorRun>;
}

export interface WindowsInstallRequest {
  version?: string;
  tarball?: string;
  replaceRunning?: boolean;
  logger?: Logger;
}

/** Seams for this machine's tests: its home and the connector runner. */
export interface LocalWindowsSeams {
  home?: () => string;
  run?: WindowsConnectorRunner;
}

/** This machine's Windows operations, on its own home. */
export function localWindowsOps(seams: LocalWindowsSeams = {}): WindowsHostOps {
  const home = () => seams.home?.() ?? clientHome();
  return {
    installedVersion: () => windowsInstalledVersion(home()),
    pipePresent: () => controlPipePresent(home()),
    install: (opts) =>
      installWindowsDaemon({
        ...(opts.version !== undefined ? { version: opts.version } : {}),
        ...(opts.tarball !== undefined ? { tarball: opts.tarball } : {}),
        ...(opts.replaceRunning !== undefined ? { replaceRunning: opts.replaceRunning } : {}),
        ...(opts.logger ? { logger: opts.logger } : {}),
      }),
    sweep: () => sweepWindowsWorktrees(home()),
    remove: (opts) =>
      removeWindowsDaemon(home(), {
        purge: opts.purge,
        ...(opts.logger ? { logger: opts.logger } : {}),
      }),
    logs: (opts) => showWindowsLogs(home(), opts),
    connectorInstalled: () =>
      Promise.resolve({
        installed: windowsConnectorInstalled(home()),
        version: readCurrentVersion(home(), 'win32') ?? null,
      }),
    connector: (args, opts = {}) => (seams.run ?? runWindowsConnector)(home(), args, opts),
  };
}

/** The transport's Windows operations, or null for a POSIX host. */
export function windowsOps(
  transport: Transport,
  seams: LocalWindowsSeams = {},
): WindowsHostOps | null {
  if (isLocalWindows(transport)) return localWindowsOps(seams);
  const ssh = remoteWindows(transport);
  return ssh ? remoteWindowsHost(ssh) : null;
}
