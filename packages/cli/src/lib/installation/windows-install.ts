import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as http from 'node:http';
import type { Server } from 'node:net';
import { basename, join, resolve, win32 } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { initialisePrivateHome, ipcPath, listenPrivate } from '@puddle/shared/node';
import { renameWithRetry, system32Path } from '@puddle/shared/node/platform';
import { parseSums } from './desktop-update.js';
import { releaseArchiveName, releaseAssetUrl } from './releases.js';
import {
  controlPipePresent,
  startWindowsDaemon,
  stopWindowsDaemon,
  windowsRuntime,
} from './windows-daemon.js';
import { clientHome } from '../paths.js';
import { sleep } from '../transport/net.js';
import { CliError, type Logger, silentLogger } from '../types.js';
import { pinnedDaemonVersion, repoSlug } from '../version.js';

/**
 * The Windows daemon installer (docs/windows.md, decision 5): install.sh's
 * steps in Node, since a Windows host has no shell to pipe it to. Release
 * assets are `puddled-v<V>-win32-<arch>.zip`, laid out exactly like the POSIX
 * tarball (`puddled-v<V>/` holding bin\node.exe, daemon\, VERSION, PROTOCOL,
 * CONNECTOR_PROTOCOL, LICENSE and the .cmd launchers). The archive is
 * verified against the release's SHA256SUMS, unpacked by System32's tar.exe
 * (Git's GNU tar reads `C:` as a remote host), smoke-tested, and published by
 * pointing the `bin\current` junction at it; junctions need no privilege.
 */

const ZIP_NAME = /^puddled-v(\d[^-]*)-win32-[a-z0-9]+\.zip$/;
const CACHE_KEEP = 2;
const LOCK_WAIT_MS = 10 * 60_000;

export interface WindowsInstallOptions {
  home?: string;
  /** Daemon release; derived from a local zip's name, else the CLI's version train. */
  version?: string;
  /** Local `puddled-v<V>-win32-<arch>.zip` (development and air-gapped hosts). */
  tarball?: string;
  /**
   * Stop a daemon that already serves the home and start the installed one
   * (install.sh's behaviour). False when the caller only needs a daemon: one
   * that another launcher started meanwhile is then left running.
   */
  replaceRunning?: boolean;
  logger?: Logger;
  fetchFn?: typeof fetch;
}

/** The version a Windows release archive's file name carries. */
export function versionFromArchiveName(file: string): string | undefined {
  return ZIP_NAME.exec(win32.basename(file))?.[1];
}

/** `bin\puddled.cmd`: for people only — supervision always runs node.exe directly. */
export function windowsLauncher(): string {
  return '@"%~dp0current\\bin\\node.exe" "%~dp0current\\daemon\\puddled.mjs" %*\r\n';
}

/** Install `version` (or the local zip) under the home, then (re)start it. */
export async function installWindowsDaemon(opts: WindowsInstallOptions = {}): Promise<void> {
  const logger = opts.logger ?? silentLogger;
  const home = resolve(opts.home ?? clientHome());
  initialisePrivateHome(home);
  for (const dir of [join(home, 'bin', 'versions'), join(home, 'cache'), join(home, 'logs')]) {
    mkdirSync(dir, { recursive: true });
  }
  const local = opts.tarball === undefined ? undefined : resolve(opts.tarball);
  const version = opts.version ?? (local ? versionFromArchiveName(local) : pinnedDaemonVersion());
  if (version === undefined) {
    throw new CliError(
      'bad_arguments',
      `cannot derive a version from ${basename(local!)}`,
      'name it puddled-v<version>-win32-x64.zip, or pass the version explicitly',
    );
  }
  if (local !== undefined && !existsSync(local)) {
    throw new CliError('not_installed', `tarball not found: ${local}`);
  }

  const lock = await acquireInstallLock(home, logger);
  try {
    const runtime = windowsRuntime(home, version);
    if (existsSync(runtime.dir) && smokeTest(runtime, version, home)) {
      logger.info(`version ${version} already installed`);
    } else {
      const archive = local ?? (await download(home, version, opts.fetchFn ?? fetch, logger));
      if (local !== undefined) await verifyLocalArchive(local, logger);
      if (existsSync(runtime.dir)) {
        // A broken tree may still be the running daemon's: its files are locked.
        logger.info(`existing version ${version} failed validation — reinstalling`);
        await stopWindowsDaemon(home, { logger });
        rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
      mkdirSync(runtime.dir, { recursive: true });
      await extract(archive, runtime.dir);
      if (!smokeTest(runtime, version, home)) {
        rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        throw new CliError(
          'not_installed',
          `the installed tree fails its own --version smoke test`,
          `details: ${join(home, 'logs', 'install-smoke.log')}`,
        );
      }
    }
    const running = await controlPipePresent(home);
    if (running && opts.replaceRunning === false) {
      logger.info('puddled was started meanwhile — leaving it running');
    } else if (running || existsSync(join(home, 'puddled.pid'))) {
      await stopWindowsDaemon(home, { logger });
    }
    pointCurrent(home, version);
    writeFileSync(join(home, 'bin', 'puddled.cmd'), windowsLauncher());
    pruneCache(join(home, 'cache'));
    writeFileSync(join(home, 'supervisor'), 'detached\n');
    if (!running || opts.replaceRunning !== false) await startWindowsDaemon(home, version);
    logger.info(`installed puddled ${version} under ${home} (supervisor: detached)`);
  } finally {
    await new Promise<void>((resolve) => lock.close(() => resolve()));
  }
}

/** A pipe server as a mutex: it vanishes with its process, so no lock is ever stale. */
async function acquireInstallLock(home: string, logger: Logger): Promise<Server> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let announced = false;
  for (;;) {
    try {
      return await listenPrivate(ipcPath(home, 'install'), (socket) => socket.destroy());
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('already active')) throw err;
      if (Date.now() >= deadline) {
        throw new CliError('already_running', 'another daemon installation is still running');
      }
      if (!announced) logger.info('waiting for another daemon installation to finish');
      announced = true;
      await sleep(500);
    }
  }
}

/** `node.exe daemon\puddled.mjs --version` must name the expected release. */
function smokeTest(runtime: ReturnType<typeof windowsRuntime>, version: string, home: string) {
  const log = join(home, 'logs', 'install-smoke.log');
  if (!existsSync(runtime.node) || !existsSync(runtime.entry)) return false;
  const result = spawnSync(runtime.node, [runtime.entry, '--version'], {
    windowsHide: true,
    encoding: 'utf8',
    // A freshly unpacked runtime is scanned by Defender on its first run.
    timeout: 120_000,
  });
  if (result.status === 0 && result.stdout.startsWith(`puddled ${version} `)) {
    rmSync(log, { force: true });
    return true;
  }
  writeFileSync(
    log,
    `${result.error?.message ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
  return false;
}

async function download(
  home: string,
  version: string,
  fetchFn: typeof fetch,
  logger: Logger,
): Promise<string> {
  const slug = repoSlug();
  if (slug === undefined) {
    throw new CliError(
      'not_installed',
      'no release source is configured for this build',
      'pass --tarball <path> (a puddled-v<version>-win32-x64.zip) or set PUDDLE_REPO=owner/repo',
    );
  }
  // Every Windows host takes the x64 archive: arm64 runs it under emulation in v1.
  const file = releaseArchiveName('puddled', version, 'win32');
  const url = releaseAssetUrl(slug, version, file);
  const archive = join(home, 'cache', file);
  logger.info(`fetching ${url}`);
  await withEnvironmentProxy(async () => {
    const response = await fetchFn(url, { headers: { 'user-agent': 'puddle-cli' } });
    if (!response.ok || response.body === null) {
      throw new CliError('not_installed', `download failed (HTTP ${response.status})`);
    }
    const partial = `${archive}.partial`;
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
      createWriteStream(partial),
    );
    await renameWithRetry(partial, archive);
    const sums = await fetchFn(releaseAssetUrl(slug, version, 'SHA256SUMS'), {
      headers: { 'user-agent': 'puddle-cli' },
    });
    if (!sums.ok) {
      throw new CliError('not_installed', `checksums download failed (HTTP ${sums.status})`);
    }
    const expected = parseSums(await sums.text()).get(file);
    if (expected === undefined || expected !== (await sha256(archive))) {
      rmSync(archive, { force: true });
      throw new CliError('not_installed', 'checksum mismatch — deleted the download');
    }
  });
  return archive;
}

/** A local zip is verified when its `<zip>.sha256` sits beside it, as with --tarball elsewhere. */
async function verifyLocalArchive(archive: string, logger: Logger): Promise<void> {
  const sums = `${archive}.sha256`;
  if (!existsSync(sums)) {
    logger.info('warning: --tarball without a .sha256 — checksum verification skipped');
    return;
  }
  const expected = parseSums(readFileSync(sums, 'utf8')).get(basename(archive));
  if (expected !== (await sha256(archive))) {
    throw new CliError('not_installed', `checksum mismatch for ${archive}`);
  }
}

function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  return pipeline(createReadStream(file), hash).then(() => hash.digest('hex'));
}

/**
 * fetch honours HTTPS_PROXY/HTTP_PROXY/NO_PROXY only once asked to: curl did
 * that for install.sh. Node releases without the switch download directly.
 */
async function withEnvironmentProxy<T>(run: () => Promise<T>): Promise<T> {
  const configure = (
    http as unknown as { setGlobalProxyFromEnv?: (env?: NodeJS.ProcessEnv) => () => void }
  ).setGlobalProxyFromEnv;
  const proxied = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(
    (name) => (process.env[name] ?? '') !== '',
  );
  const restore = proxied && configure ? configure(process.env) : undefined;
  try {
    return await run();
  } finally {
    restore?.();
  }
}

/** Unpack the archive's single top-level folder into `dest`. */
function extract(archive: string, dest: string): Promise<void> {
  const tar = system32Path('tar.exe');
  return new Promise((resolve, reject) => {
    execFile(
      tar,
      ['-xf', archive, '--strip-components', '1', '-C', dest],
      { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        reject(
          new CliError(
            'not_installed',
            `extraction failed: ${String(stderr).trim() || error.message}`,
            existsSync(tar) ? undefined : 'tar.exe ships with Windows 10 1803 and later',
          ),
        );
      },
    );
  });
}

/**
 * Point `bin\current` at the version. A junction cannot be replaced
 * atomically, so it is removed and recreated under the install lock; readers
 * that race the flip see no installed version for a moment, never a wrong one.
 */
export function pointCurrent(home: string, version: string): void {
  const current = join(home, 'bin', 'current');
  try {
    const st = lstatSync(current);
    if (st.isSymbolicLink()) unlinkSync(current);
    else rmSync(current, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  symlinkSync(windowsRuntime(home, version).dir, current, 'junction');
}

/** Keep the current download and one previous, like install.sh. */
export function pruneCache(cache: string): void {
  let archives: Array<{ path: string; mtime: number }>;
  try {
    archives = readdirSync(cache)
      .filter((name) => ZIP_NAME.test(name))
      .map((name) => ({ path: join(cache, name), mtime: statSync(join(cache, name)).mtimeMs }));
  } catch {
    return;
  }
  archives.sort((a, b) => b.mtime - a.mtime);
  for (const old of archives.slice(CACHE_KEEP)) rmSync(old.path, { force: true });
}
