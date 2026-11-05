import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsOps, type WindowsHostOps } from '../host/windows-ops.js';
import { hostPaths } from '../paths.js';
import type { Transport } from '../transport/transport.js';
import { CliError, type Logger, silentLogger } from '../types.js';
import { pinnedDaemonVersion, repoSlug } from '../version.js';

export interface BootstrapOptions {
  /** Daemon release to install; defaults to the CLI's own version train. */
  version?: string;
  /** Local tarball path or URL (dev override / air-gapped hosts). */
  tarball?: string;
  logger?: Logger;
  /**
   * Windows only (install.sh always restarts its supervisor): false leaves a
   * daemon that another launcher started meanwhile running.
   */
  replaceRunning?: boolean;
}

/**
 * The daemon version installed under ~/.puddle/bin, read from the `current`
 * symlink's target (versions/<X.Y.Z>) — never by executing an unknown
 * `puddled` (a pre-Phase-6 binary would START a daemon on --version).
 * Null when nothing bootstrap-managed is installed. A Windows host answers
 * through its own implementation (host/windows-ops.ts), where a tree of
 * another architecture is not installed: this is what installation decides
 * on. One recognised only by this command failing is asked again.
 */
export function installedVersion(transport: Transport): Promise<string | null> {
  return linkedVersion(transport, (windows) => windows.installedVersion());
}

/**
 * The daemon version present under ~/.puddle/bin, whatever its architecture:
 * what removal and upgrades act on. The same command as installedVersion on
 * a POSIX host; on Windows an x64 tree on Arm (every v1 install there) is
 * still found, so it can be removed or replaced.
 */
export function presentVersion(transport: Transport): Promise<string | null> {
  return linkedVersion(transport, (windows) => windows.presentVersion());
}

async function linkedVersion(
  transport: Transport,
  ask: (windows: WindowsHostOps) => Promise<string | null>,
): Promise<string | null> {
  const windows = windowsOps(transport);
  if (windows) return ask(windows);
  const result = await transport.exec(`readlink ${hostPaths.current}`, { timeoutMs: 15_000 });
  if (result.code !== 0) {
    const recognised = windowsOps(transport);
    return recognised ? ask(recognised) : null;
  }
  const match = /versions\/([^/\s]+)\s*$/.exec(result.stdout.trim());
  return match?.[1] ?? null;
}

/**
 * Install or upgrade the daemon by piping the embedded install.sh over the
 * transport — the exact script this CLI shipped with, so bootstrap logic has
 * one implementation (SPEC §10). A local --tarball is delivered to the host
 * cache first (scp over the master when remote).
 */
export async function installDaemon(
  transport: Transport,
  opts: BootstrapOptions = {},
): Promise<void> {
  const logger = opts.logger ?? silentLogger;
  const windows = windowsOps(transport);
  if (windows) return installWindows(transport, opts, logger);
  const version = opts.version ?? pinnedDaemonVersion();
  const script = readInstallScript();

  const args: string[] = ['--version', version];
  if (opts.tarball !== undefined && !/^https?:\/\//.test(opts.tarball)) {
    if (!existsSync(opts.tarball)) {
      throw new CliError('not_installed', `tarball not found: ${opts.tarball}`);
    }
    if (transport.kind === 'local') {
      // The installer runs on this machine and can read the file in place.
      args.push('--tarball', resolve(opts.tarball));
      const localSums = `${opts.tarball}.sha256`;
      if (existsSync(localSums)) args.push('--sums', resolve(localSums));
    } else {
      // A Windows client's path may use either separator.
      const base =
        (process.platform === 'win32'
          ? win32.basename(opts.tarball)
          : opts.tarball.split('/').pop()) ?? 'puddled.tar.gz';
      // Home-relative on purpose: scp's sftp backend does no remote shell
      // expansion, and ssh exec's cwd is the home dir, so both resolve it.
      const destTarball = `.puddle/cache/${base}`;
      logger.info(`delivering ${base} to ${transport.label}`);
      await transport.copyTo(opts.tarball, destTarball);
      const sums = `${opts.tarball}.sha256`;
      if (existsSync(sums)) {
        await transport.copyTo(sums, `${destTarball}.sha256`);
        args.push('--tarball', destTarball, '--sums', `${destTarball}.sha256`);
      } else {
        args.push('--tarball', destTarball);
      }
    }
  } else {
    const slug = repoSlug();
    if (opts.tarball !== undefined) {
      // A URL tarball is fetched host-side by curl via --tarball? No: the
      // installer's --tarball takes a file path, so fetch-by-URL rides the
      // normal --repo path only. Reject to avoid a silent misread.
      throw new CliError('bad_arguments', '--tarball must be a local file path');
    }
    if (slug === undefined) {
      throw new CliError(
        'not_installed',
        'no release source is configured for this build',
        'pass --tarball <path> (pnpm build:tarball produces one) or set PUDDLE_REPO=owner/repo',
      );
    }
    args.push('--repo', slug);
  }

  logger.info(`installing puddled ${version} on ${transport.label}`);
  const quoted = args.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ');
  const result = await transport.exec(`sh -s -- ${quoted}`, {
    stdin: script,
    timeoutMs: 10 * 60_000,
    onStdout: (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim() !== '') logger.info(line.trimEnd());
    },
  });
  if (result.code !== 0) {
    // install.sh named a Git Bash kernel: the host is Windows after all.
    if (windowsOps(transport)) return installWindows(transport, opts, logger);
    throw new CliError(
      'not_installed',
      `the installer failed on ${transport.label} (exit ${result.code})`,
      lastLines(result.stderr || result.stdout),
    );
  }
}

/**
 * A Windows host installs with installation/windows-install.ts, never
 * install.sh: in process here, or through the host helper over SSH.
 */
function installWindows(
  transport: Transport,
  opts: BootstrapOptions,
  logger: Logger,
): Promise<void> {
  if (opts.tarball !== undefined && /^https?:\/\//.test(opts.tarball)) {
    throw new CliError('bad_arguments', '--tarball must be a local file path');
  }
  return windowsOps(transport)!.install({
    ...(opts.version !== undefined ? { version: opts.version } : {}),
    ...(opts.tarball !== undefined ? { tarball: opts.tarball } : {}),
    ...(opts.replaceRunning !== undefined ? { replaceRunning: opts.replaceRunning } : {}),
    logger,
  });
}

function lastLines(text: string, count = 3): string {
  return text.trim().split('\n').slice(-count).join('\n');
}

/**
 * The canonical install.sh: dist builds ship it next to the bundle
 * (packages/cli/scripts/build.mjs copies it); dev runs (vitest over src)
 * read it from the repo.
 */
export function readInstallScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'install.sh'), // dist/index.js → dist/install.sh
    join(here, '..', '..', '..', '..', '..', 'scripts', 'install.sh'), // src/lib/installation/ → repo root
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new CliError('not_installed', 'install.sh is missing from this build');
}
