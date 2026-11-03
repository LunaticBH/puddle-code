import { installDaemon, installedVersion, type BootstrapOptions } from './bootstrap.js';
import { inspectHost } from '../auth/control-channel.js';
import type { Transport } from '../transport/transport.js';
import { type Logger, silentLogger } from '../types.js';
import { pinnedDaemonVersion } from '../version.js';

export interface UpgradeResult {
  from: string | null;
  to: string;
  liveSessions: number;
}

/**
 * Unconditional daemon reinstall to the CLI's pinned version — `puddle
 * upgrade` (SPEC §6: never required within a protocol major, always
 * available). Prints the interruption count first via the returned data.
 */
export async function upgradeDaemon(
  transport: Transport,
  opts: BootstrapOptions & { logger?: Logger; probeLive?: boolean } = {},
): Promise<UpgradeResult> {
  const logger = opts.logger ?? silentLogger;
  const from = await installedVersion(transport);

  const liveSessions = (await inspectHost(transport).catch(() => null))?.liveSessions ?? 0;
  if (liveSessions > 0) {
    logger.info(`${liveSessions} live session(s) will be interrupted and can be resumed`);
  }

  await installDaemon(transport, opts);
  return { from, to: opts.version ?? pinnedDaemonVersion(), liveSessions };
}
