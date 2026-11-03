import { PROTOCOL_VERSION, type HostInspection, type VersionResponse } from '@puddle/shared';
import { CliError, type Logger, silentLogger } from '../types.js';

export type HandshakeDecision =
  | { kind: 'proceed' }
  | { kind: 'upgrade-daemon' }
  | { kind: 'refuse-cli-outdated'; command: string };

export const CLI_UPGRADE_COMMAND = 'puddle upgrade cli';

/** One compatibility policy for host inspection and authenticated API verification. */
export function decideHandshake(
  cli: { major: number },
  daemon: { major: number },
): HandshakeDecision {
  if (daemon.major === cli.major) return { kind: 'proceed' };
  if (daemon.major < cli.major) return { kind: 'upgrade-daemon' };
  return { kind: 'refuse-cli-outdated', command: CLI_UPGRADE_COMMAND };
}

export interface DaemonUpgradeRequest {
  host: string;
  daemon: VersionResponse;
  clientProtocol: typeof PROTOCOL_VERSION;
  liveSessions: number;
}

/** Shell-owned UI; absent callbacks never authorise an upgrade. */
export type ConfirmDaemonUpgrade = (request: DaemonUpgradeRequest) => Promise<boolean>;

export function daemonUpgradeMessage(request: DaemonUpgradeRequest): string {
  const { host, daemon, clientProtocol, liveSessions } = request;
  return (
    `${host} runs puddled ${daemon.version} (protocol ${daemon.protocol.major}.${daemon.protocol.minor}). ` +
    `This client uses protocol ${clientProtocol.major}.${clientProtocol.minor} and needs the same protocol major.\n\n` +
    `Updating the host daemon will interrupt ${liveSessions} live session(s). ` +
    'Their saved state remains and they can resume after the update.'
  );
}

/** Verify an established connection without ever initiating a second upgrade. */
export function verifyDaemonVersion(daemon: VersionResponse): VersionResponse {
  const decision = decideHandshake(PROTOCOL_VERSION, daemon.protocol);
  if (decision.kind === 'proceed') return daemon;
  if (decision.kind === 'refuse-cli-outdated') {
    throw new CliError(
      'cli_outdated',
      `the daemon speaks protocol ${daemon.protocol.major}; this client speaks ${PROTOCOL_VERSION.major}`,
      `update the desktop app, or update the CLI: ${decision.command}`,
    );
  }
  throw new CliError(
    'protocol_mismatch',
    `the daemon speaks protocol ${daemon.protocol.major}; this client speaks ${PROTOCOL_VERSION.major}`,
    'reconnect to update the host daemon',
  );
}

export interface RunHandshakeOptions {
  host: string;
  inspection: HostInspection;
  noUpgrade?: boolean;
  confirmDaemonUpgrade?: ConfirmDaemonUpgrade;
  /** Recheck the host after a potentially long user prompt. */
  reinspect?: () => Promise<HostInspection | null>;
  /** Install, reacquire host authority and return the replacement's version. */
  upgradeDaemon: () => Promise<VersionResponse>;
  logger?: Logger;
}

/** Negotiate before opening the API/tunnel; all host upgrades pass through here. */
export async function runHandshake(opts: RunHandshakeOptions): Promise<VersionResponse> {
  const { version: daemon, liveSessions } = opts.inspection;
  if (decideHandshake(PROTOCOL_VERSION, daemon.protocol).kind !== 'upgrade-daemon') {
    return verifyDaemonVersion(daemon);
  }
  if (opts.noUpgrade) {
    throw new CliError(
      'upgrade_failed',
      `the daemon speaks protocol ${daemon.protocol.major} (client: ${PROTOCOL_VERSION.major}) and --no-upgrade is set`,
      `re-run without --no-upgrade to update it (${liveSessions} live session(s) would be interrupted and can be resumed)`,
    );
  }
  const request: DaemonUpgradeRequest = {
    host: opts.host,
    daemon,
    clientProtocol: PROTOCOL_VERSION,
    liveSessions,
  };
  if (!(await opts.confirmDaemonUpgrade?.(request))) {
    throw new CliError(
      'upgrade_failed',
      `the daemon update on ${opts.host} was not approved`,
      'launch again to approve the update, or run puddle upgrade daemon with the host as an optional argument',
    );
  }
  const latest = await opts.reinspect?.();
  if (
    latest &&
    decideHandshake(PROTOCOL_VERSION, latest.version.protocol).kind !== 'upgrade-daemon'
  ) {
    return verifyDaemonVersion(latest.version);
  }
  const logger = opts.logger ?? silentLogger;
  logger.info(
    `updating puddled on ${opts.host} (protocol ${daemon.protocol.major} → ${PROTOCOL_VERSION.major}) — ` +
      `${liveSessions} live session(s) will be interrupted and can be resumed`,
  );
  try {
    return verifyDaemonVersion(await opts.upgradeDaemon());
  } catch (err) {
    if (err instanceof CliError && ['cli_outdated', 'protocol_mismatch'].includes(err.code)) {
      throw new CliError(
        'upgrade_failed',
        `the daemon protocol is still incompatible after updating: ${err.message}`,
        'inspect the daemon logs: puddle logs',
      );
    }
    throw err;
  }
}
