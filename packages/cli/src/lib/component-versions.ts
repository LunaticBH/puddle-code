import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@puddle/shared';
import { findInstalledDesktopApp } from './desktop-update.js';
import { clientHome } from './paths.js';
import { cliVersion } from './version.js';

export interface SpeakingProtocol {
  major: number;
  minor: number;
}

export interface InstalledComponentVersion {
  component: 'cli' | 'daemon' | 'desktop';
  installed: boolean;
  /** Display-only remote protocol spoken by the bundled connector. */
  connectorProtocol?: number;
  version?: string;
  protocol?: SpeakingProtocol;
}

export interface DesktopInstallation {
  path: string;
  version: string;
  protocol?: SpeakingProtocol;
}

interface InventoryOptions {
  home?: string;
  platform?: NodeJS.Platform;
  findDesktop?: typeof findInstalledDesktopApp;
}

/**
 * Released versions before components started carrying exact protocol
 * metadata. Keep this historical ledger immutable; append the new release in
 * its release commit so an older installed peer remains identifiable offline.
 */
const RELEASE_PROTOCOLS: Readonly<Record<string, SpeakingProtocol>> = {
  '0.0.1': { major: 5, minor: 1 },
  '0.0.2': { major: 6, minor: 0 },
  '0.0.3': { major: 6, minor: 2 },
  '0.0.4': { major: 6, minor: 2 },
  '0.0.5': { major: 7, minor: 0 },
  '0.0.6': { major: 7, minor: 1 },
  '0.0.7': { major: 7, minor: 1 },
  '0.0.8': { major: 7, minor: 4 },
  '0.0.9': { major: 8, minor: 0 },
  '0.0.10': { major: 9, minor: 1 },
  '0.0.11': { major: 9, minor: 2 },
  '0.0.12': { major: 10, minor: 1 },
  '0.0.13': { major: 10, minor: 1 },
  '0.0.14': { major: 10, minor: 1 },
  '0.0.15': { major: 10, minor: 1 },
  '0.0.16': { major: 10, minor: 4 },
  '0.0.17': { major: 10, minor: 7 },
  '0.0.18': { major: 11, minor: 0 },
  '0.0.19': { major: 11, minor: 1 },
  '0.0.20': { major: 11, minor: 1 },
  '0.0.21': { major: 11, minor: 1 },
  '0.0.22': { major: 12, minor: 3 },
  '0.0.23': { major: 12, minor: 3 },
  '0.0.24': { major: 12, minor: 3 },
  '0.0.25': { major: 13, minor: 0 },
  '0.0.26': { major: 13, minor: 0 },
  '0.0.27': { major: 13, minor: 0 },
  '0.0.28': { major: 13, minor: 0 },
  '0.0.29': { major: 13, minor: 1 },
  '0.0.30': { major: 13, minor: 1 },
  '0.0.31': { major: 13, minor: 1 },
  '0.0.32': { major: 14, minor: 0 },
  '0.0.33': { major: 14, minor: 2 },
  '0.0.34': { major: 14, minor: 2 },
  '0.0.35': { major: 15, minor: 1 },
  '0.0.36': { major: 15, minor: 2 },
  '0.0.37': { major: 15, minor: 2 },
  '0.0.38': { major: 15, minor: 2 },
  '0.0.39': { major: 15, minor: 3 },
  '0.0.40': { major: 15, minor: 3 },
  '0.0.41': { major: 15, minor: 3 },
  '0.0.42': { major: 16, minor: 0 },
  '0.0.43': { major: 16, minor: 0 },
  '0.0.44': { major: 16, minor: 0 },
  '0.0.47': { major: 16, minor: 1 },
  '0.0.48': { major: 16, minor: 1 },
  '0.0.49': { major: 16, minor: 1 },
  '0.0.50': { major: 16, minor: 1 },
  '0.0.51': { major: 16, minor: 2 },
  '0.0.52': { major: 16, minor: 3 },
  '0.0.53': { major: 16, minor: 3 },
  '0.0.54': { major: 16, minor: 3 },
  '0.0.55': { major: 16, minor: 3 },
  '0.0.56': { major: 16, minor: 4 },
  '0.1.0': { major: 17, minor: 0 },
  '0.1.1': { major: 17, minor: 0 },
  '0.1.2': { major: 17, minor: 0 },
  '0.1.3': { major: 17, minor: 0 },
  '0.1.4': { major: 17, minor: 0 },
  '0.1.5': { major: 17, minor: 0 },
  '0.1.6': { major: 17, minor: 2 },
  '0.1.7': { major: 17, minor: 2 },
  '0.1.8': { major: 17, minor: 2 },
  '0.1.9': { major: 17, minor: 3 },
  '0.1.10': { major: 17, minor: 3 },
  '0.1.11': { major: 17, minor: 3 },
  '0.1.12': { major: 17, minor: 3 },
  '0.1.13': { major: 17, minor: 3 },
  '0.2.0': { major: 19, minor: 0 },
  '0.2.1': { major: 19, minor: 0 },
  '0.2.2': { major: 20, minor: 0 },
  '0.2.3': { major: 20, minor: 0 },
  '0.2.4': { major: 21, minor: 2 },
  '0.2.5': { major: 21, minor: 2 },
  '0.2.6': { major: 21, minor: 2 },
  '0.2.7': { major: 21, minor: 3 },
  '0.2.8': { major: 22, minor: 0 },
  '0.2.9': { major: 22, minor: 0 },
  '0.2.10': { major: 22, minor: 0 },
  '0.2.11': { major: 22, minor: 0 },
  '0.2.12': { major: 22, minor: 0 },
  '0.2.13': { major: 22, minor: 0 },
  '0.2.14': { major: 22, minor: 0 },
  '0.2.15': { major: 22, minor: 0 },
  '0.2.16': { major: 22, minor: 0 },
  '0.2.17': { major: 22, minor: 0 },
  '0.2.18': { major: 22, minor: 0 },
  '0.2.19': { major: 22, minor: 0 },
  '0.2.20': { major: 22, minor: 4 },
  '0.2.21': { major: 22, minor: 4 },
  '0.2.22': { major: 22, minor: 4 },
  '0.2.23': { major: 22, minor: 5 },
  '0.2.24': { major: 22, minor: 5 },
  '0.3.0': { major: 23, minor: 0 },
  '0.3.1': { major: 23, minor: 0 },
  '0.3.2': { major: 24, minor: 0 },
  '0.3.3': { major: 24, minor: 2 },
  '0.3.4': { major: 24, minor: 6 },
  '0.3.5': { major: 25, minor: 0 },
  '0.3.6': { major: 25, minor: 0 },
  '0.3.7': { major: 25, minor: 1 },
  '0.3.8': { major: 25, minor: 1 },
  '0.3.9': { major: 25, minor: 3 },
  '0.3.10': { major: 25, minor: 4 },
  '0.3.11': { major: 25, minor: 4 },
  '0.3.12': { major: 25, minor: 5 },
  '0.3.13': { major: 25, minor: 6 },
};

function validProtocol(value: unknown): value is SpeakingProtocol {
  if (typeof value !== 'object' || value === null) return false;
  const protocol = value as Record<string, unknown>;
  return (
    typeof protocol['major'] === 'number' &&
    Number.isInteger(protocol['major']) &&
    protocol['major'] >= 0 &&
    typeof protocol['minor'] === 'number' &&
    Number.isInteger(protocol['minor']) &&
    protocol['minor'] >= 0
  );
}

export function releasedProtocol(version: string): SpeakingProtocol | undefined {
  return RELEASE_PROTOCOLS[version];
}

/** Exact release ledger first; the not-yet-ledgered current release second. */
export function componentProtocolForVersion(version: string): SpeakingProtocol | undefined {
  return releasedProtocol(version) ?? (version === cliVersion() ? PROTOCOL_VERSION : undefined);
}

function desktopRecordFile(home: string): string {
  return join(home, 'desktop-install.json');
}

function readDesktopInstallation(file: string): DesktopInstallation | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (typeof record['path'] !== 'string' || typeof record['version'] !== 'string') return null;
    const protocol = validProtocol(record['protocol']) ? record['protocol'] : undefined;
    return {
      path: record['path'],
      version: record['version'],
      ...(protocol ? { protocol } : {}),
    };
  } catch {
    return null;
  }
}

/** Record a packaged desktop wherever it actually lives, including AppImages. */
export function recordDesktopInstallation(
  installation: DesktopInstallation,
  file = desktopRecordFile(clientHome()),
): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(installation, null, 2)}\n`);
    renameSync(temp, file);
  } catch {
    // Best-effort metadata must never prevent an install, launch, or update.
  }
}

function daemonVersion(home: string): string | undefined {
  try {
    const target = readlinkSync(join(home, 'bin', 'current'));
    return /(?:^|\/)versions\/([^/\s]+)$/.exec(target)?.[1];
  } catch {
    return undefined;
  }
}

function daemonProtocol(home: string, version: string): SpeakingProtocol | undefined {
  try {
    const raw = readFileSync(join(home, 'bin', 'current', 'PROTOCOL'), 'utf8').trim();
    const match = /^(\d+)\.(\d+)$/.exec(raw);
    if (match) return { major: Number(match[1]), minor: Number(match[2]) };
  } catch {
    // Legacy releases predate the exact metadata file; use their ledger.
  }
  return releasedProtocol(version);
}

function daemonConnectorProtocol(home: string, version: string): number | undefined {
  try {
    const raw = readFileSync(join(home, 'bin', 'current', 'CONNECTOR_PROTOCOL'), 'utf8').trim();
    if (/^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
    return undefined;
  } catch {
    // Every published 0.2.0–0.2.7 daemon bundled remote protocol 2.
    return /^0\.2\.[0-7]$/.test(version) ? 2 : undefined;
  }
}

/** Local, offline inventory used by `puddle --version`. */
export async function installedComponentVersions(
  opts: InventoryOptions = {},
): Promise<InstalledComponentVersion[]> {
  const home = opts.home ?? clientHome();
  const cli: InstalledComponentVersion = {
    component: 'cli',
    installed: true,
    version: cliVersion(),
    protocol: PROTOCOL_VERSION,
  };

  const installedDaemon = daemonVersion(home);
  const installedDaemonProtocol =
    installedDaemon === undefined ? undefined : daemonProtocol(home, installedDaemon);
  const connectorProtocol =
    installedDaemon === undefined ? undefined : daemonConnectorProtocol(home, installedDaemon);
  const daemon: InstalledComponentVersion =
    installedDaemon === undefined
      ? { component: 'daemon', installed: false }
      : {
          component: 'daemon',
          installed: true,
          version: installedDaemon,
          ...(connectorProtocol !== undefined ? { connectorProtocol } : {}),
          ...(installedDaemonProtocol ? { protocol: installedDaemonProtocol } : {}),
        };

  const recordedDesktop = readDesktopInstallation(desktopRecordFile(home));
  let desktopInstallation =
    recordedDesktop !== null && existsSync(recordedDesktop.path) ? recordedDesktop : null;
  if (desktopInstallation === null && (opts.platform ?? process.platform) === 'darwin') {
    const found = await (opts.findDesktop ?? findInstalledDesktopApp)();
    if (found !== null) {
      const protocol = componentProtocolForVersion(found.version);
      desktopInstallation = {
        path: found.appPath,
        version: found.version,
        ...(protocol ? { protocol } : {}),
      };
    }
  }
  // Before path records, the Linux installer defaulted here. The stable file
  // name carries no version, so presence is still worth reporting honestly.
  const legacyLinuxPath = resolve(home, '..', 'puddle', 'Puddle.AppImage');
  const legacyLinuxDesktop =
    desktopInstallation === null &&
    (opts.platform ?? process.platform) === 'linux' &&
    existsSync(legacyLinuxPath);
  const desktopProtocol =
    desktopInstallation?.protocol ??
    (desktopInstallation ? componentProtocolForVersion(desktopInstallation.version) : undefined);
  const desktop: InstalledComponentVersion =
    desktopInstallation !== null
      ? {
          component: 'desktop',
          installed: true,
          version: desktopInstallation.version,
          ...(desktopProtocol ? { protocol: desktopProtocol } : {}),
        }
      : legacyLinuxDesktop
        ? { component: 'desktop', installed: true }
        : { component: 'desktop', installed: false };

  return [cli, daemon, desktop];
}

export function formatComponentVersions(components: InstalledComponentVersion[]): string {
  return components
    .map((component) => {
      const name = component.component.padEnd(7);
      if (!component.installed) return `${name} not installed`;
      const version = component.version ?? 'unknown version';
      const protocol = component.protocol
        ? `protocol ${component.protocol.major}.${component.protocol.minor}${component.component === 'daemon' && component.connectorProtocol !== undefined ? `c${component.connectorProtocol}` : ''}`
        : 'protocol unknown';
      return `${name} ${version} (${protocol})`;
    })
    .join('\n');
}
