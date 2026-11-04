import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
import { copyFile } from 'node:fs/promises';
import * as http from 'node:http';
import type { Server } from 'node:net';
import { basename, join, resolve, win32 } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { initialisePrivateHome, ipcPath, listenPrivate, rotateIpcNonce } from '@puddle/shared/node';
import {
  isPidAlive,
  registerSupervisorTask,
  renameWithRetry,
  shipsSupervisor,
  startWindowsSupervisor,
  supervisorRequest,
  system32Path,
  unregisterWindowsTask,
  supervisorTaskName,
  type StartSupervisorOptions,
} from '@puddle/shared/node/platform';
import { readCurrentVersion } from './current-link.js';
import { parseSums } from './desktop-update.js';
import { releaseArchiveName, releaseAssetUrl } from './releases.js';
import {
  controlPipeState,
  homeDaemonPids,
  startWindowsDaemon,
  stopWindowsDaemon,
  stopWindowsSupervisor,
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
/** ensureDaemon's start allowance: Defender scans a freshly unpacked runtime. */
const SERVE_WAIT_MS = 60_000;
/** Longer than the shared process table keeps a snapshot. */
const PROCESS_SNAPSHOT_MS = 300;

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
  /** Seams for tests: no test registers a real scheduled task. */
  supervision?: WindowsSupervisionSeams;
}

/** Task Scheduler and WMI through an injected PowerShell, and the detached fallback. */
export type WindowsSupervisionSeams = Pick<
  StartSupervisorOptions,
  'powershell' | 'spawnDetached' | 'waitMs'
>;

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

  let lock = await acquireInstallLock(home, logger);
  try {
    const runtime = windowsRuntime(home, version);
    if (existsSync(runtime.dir) && (await smokeTest(runtime, version, home))) {
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
      await extract(home, archive, runtime.dir);
      if (!(await smokeTest(runtime, version, home))) {
        rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        throw new CliError(
          'not_installed',
          `the installed tree fails its own --version smoke test`,
          `details: ${join(home, 'logs', 'install-smoke.log')}`,
        );
      }
    }
    let pipe = await controlPipeState(home);
    let supervisor = (await supervisorRequest(home, 'status')).kind;
    if (pipe === 'foreign' || supervisor === 'foreign') {
      // Another account serves a name an earlier run used. Renamed under the
      // lock, the home's pipes leave it behind; the lock moves with them, and
      // its new name, keyed by the private ipc-key, says nothing of the
      // daemon's. A supervisor of this home would be left on the old names.
      logger.warn(
        pipe === 'foreign'
          ? 'a process that is not this home’s daemon holds its control pipe — renaming it'
          : 'a process that is not this home’s supervisor holds its pipe — renaming it',
      );
      if (supervisor === 'answered') await stopWindowsSupervisor(home, { logger });
      rotateIpcNonce(home);
      lock = await relock(home, lock, logger);
      pipe = await controlPipeState(home);
      supervisor = (await supervisorRequest(home, 'status')).kind;
    }
    const running = pipe === 'daemon' || pipe === 'unknown';
    // A supervisor between restarts, or starting its daemon, counts as running it.
    const supervising = supervisor === 'answered' || supervisor === 'unavailable';
    const pidFile = existsSync(join(home, 'puddled.pid'));
    // A launcher that only needs a daemon never stops one that another
    // launcher started, even one that has not served its pipe yet.
    const starting =
      opts.replaceRunning === false &&
      !running &&
      (supervising || (pidFile && (await daemonStarting(home))));
    const leave = opts.replaceRunning === false && (running || starting);
    if (leave) {
      logger.info(`puddled was ${running ? 'started' : 'starting'} meanwhile — leaving it running`);
    } else if (running || pidFile || supervising) {
      await stopWindowsDaemon(home, { logger });
    }
    // The launcher that started a running daemon pointed `current` at it.
    if (!leave || readCurrentVersion(home, 'win32') === undefined) pointCurrent(home, version);
    writeFileSync(join(home, 'bin', 'puddled.cmd'), windowsLauncher());
    pruneCache(join(home, 'cache'));
    const kind = await supervise(home, leave, logger, opts.supervision ?? {});
    if (leave) {
      logger.info(`puddled ${version} is unpacked; the running daemon was left in place`);
      return;
    }
    logger.info(`installed puddled ${version} under ${home} (supervisor: ${kind})`);
  } finally {
    await new Promise<void>((resolve) => lock.close(() => resolve()));
  }
}

/**
 * Whether a daemon of this home runs, identified by its command line. The
 * shared process table answers from a snapshot up to 250 ms old, which a
 * daemon spawned since then is missing from: while `puddled.pid` names a
 * live process the snapshot lacks, the table is asked once more after that.
 */
async function daemonStarting(home: string): Promise<boolean> {
  let recorded = 0;
  try {
    recorded = Number.parseInt(readFileSync(join(home, 'puddled.pid'), 'utf8'), 10);
  } catch {
    // Removed by a stop meanwhile.
  }
  for (let attempt = 0; ; attempt++) {
    const pids = await homeDaemonPids(home).catch(() => [] as number[]);
    if (pids.length > 0) return true;
    if (attempt > 0 || !(recorded > 0) || !isPidAlive(recorded, 'win32')) return false;
    await sleep(PROCESS_SNAPSHOT_MS);
  }
}

/**
 * Register the home's logon task and start its supervisor (none on the
 * `leave` path, whose daemon already runs), recording the supervisor marker:
 * `task` when the task is registered, else `detached`, under which the next
 * launch starts the supervisor again and remote access cannot be enabled.
 * A release from before the supervisor runs its daemon detached, as it did.
 */
async function supervise(
  home: string,
  leave: boolean,
  logger: Logger,
  seams: WindowsSupervisionSeams,
): Promise<'task' | 'detached'> {
  const marker = join(home, 'supervisor');
  const current = readCurrentVersion(home, 'win32');
  if (current === undefined || !shipsSupervisor(windowsRuntime(home, current).dir)) {
    if (readMarker(marker) === 'task') {
      // Its action would run a supervisor this release does not ship.
      await unregisterWindowsTask(supervisorTaskName(home), seams).catch(() => false);
    }
    writeFileSync(marker, 'detached\n');
    if (leave || current === undefined) return 'detached';
    const pid = await startWindowsDaemon(home, current);
    // Until it serves its pipe, the next lock holder's probe could not see it.
    await servedOrGone(home, () => isPidAlive(pid, 'win32'));
    return 'detached';
  }
  // Idempotent: the action names the `current` junction, so an upgrade only refreshes it.
  const registration = await registerSupervisorTask(home, { ...seams, start: !leave });
  if (!registration.registered) {
    logger.warn(
      `could not register the scheduled task that starts puddled at logon ` +
        `(${registration.error ?? 'Task Scheduler refused it'}); launches start it instead, ` +
        'and remote access cannot be enabled on this machine',
    );
  }
  const kind = registration.registered ? 'task' : 'detached';
  writeFileSync(marker, `${kind}\n`);
  if (leave) return kind;
  const started = await startWindowsSupervisor(home, {
    ...seams,
    task: registration.registered,
    // Its user disabled the task: no logon start, and none from here either.
    ...(registration.disabled
      ? { started: { ran: false, state: 'disabled' as const } }
      : registration.ran !== undefined
        ? {
            started: {
              ran: registration.ran,
              state: registration.state ?? 'unknown',
              ...(registration.error !== undefined ? { error: registration.error } : {}),
            },
          }
        : {}),
    logger,
  });
  // One that started meanwhile may still run the connector of the release before.
  if (started === 'running') await supervisorRequest(home, 'restart_connector');
  await servedOrGone(home, async () => (await supervisorRequest(home, 'status')).kind !== 'absent');
  return kind;
}

function readMarker(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Until the daemon just started holds its control pipe, or what started it
 * (the daemon itself, or its supervisor) is gone, within the start allowance.
 */
async function servedOrGone(home: string, alive: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + SERVE_WAIT_MS;
  while (Date.now() < deadline && (await alive())) {
    if ((await controlPipeState(home, 1000)) !== 'absent') return;
    await sleep(100);
  }
}

/** After rotateIpcNonce: hold the lock's new name before releasing the old one. */
async function relock(home: string, held: Server, logger: Logger): Promise<Server> {
  const renamed = await acquireInstallLock(home, logger);
  await new Promise<void>((resolve) => held.close(() => resolve()));
  return renamed;
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

/**
 * `node.exe daemon\puddled.mjs --version` must name the expected release.
 * Asynchronous: the desktop runs this in Electron's main process, and the
 * run loads the whole daemon bundle with its native addons.
 */
async function smokeTest(
  runtime: ReturnType<typeof windowsRuntime>,
  version: string,
  home: string,
): Promise<boolean> {
  const log = join(home, 'logs', 'install-smoke.log');
  if (!existsSync(runtime.node) || !existsSync(runtime.entry)) return false;
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(
    (done) =>
      execFile(
        runtime.node,
        [runtime.entry, '--version'],
        // A freshly unpacked runtime is scanned by Defender on its first run.
        { windowsHide: true, encoding: 'utf8', timeout: 120_000 },
        (error, stdout, stderr) => done({ error, stdout, stderr }),
      ),
  );
  if (result.error === null && result.stdout.startsWith(`puddled ${version} `)) {
    rmSync(log, { force: true });
    return true;
  }
  writeFileSync(log, `${result.error?.message ?? ''}\n${result.stdout}${result.stderr}`);
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
  }).catch(downloadFailure);
  return archive;
}

/**
 * Offline, refused or cut short, fetch rejects with no status at all. Such
 * a download is as unusable as an HTTP error and as recoverable: a launcher
 * falls back on any `not_installed` (startLocalWindows).
 */
function downloadFailure(err: unknown): never {
  if (err instanceof CliError) throw err;
  const reason = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
  throw new CliError(
    'not_installed',
    `download failed: ${reason}${cause}`,
    'check the network connection, or pass --tarball <path> (a puddled-v<version>-win32-x64.zip)',
  );
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

/**
 * Unpack the archive's single top-level folder into `dest`, under `home`.
 * System32's tar.exe reads its arguments in the ANSI code page, so a path
 * outside it (a CJK profile name on an English install) would reach it as
 * `?`. It runs in the home, whose name travels intact as the working
 * directory, and is given only ASCII paths relative to it; an archive that
 * has no such path is copied into the cache first.
 */
async function extract(home: string, archive: string, dest: string): Promise<void> {
  const tar = system32Path('tar.exe');
  let source = win32.relative(home, archive);
  let copy: string | undefined;
  if (!asciiInside(source)) {
    copy = join(home, 'cache', `.extract-${randomBytes(8).toString('hex')}.zip`);
    await copyFile(archive, copy);
    source = win32.relative(home, copy);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        tar,
        ['-xf', source, '--strip-components', '1', '-C', win32.relative(home, dest)],
        { cwd: home, windowsHide: true, timeout: 10 * 60_000, maxBuffer: 1024 * 1024 },
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
  } finally {
    if (copy !== undefined) rmSync(copy, { force: true });
  }
}

/** A printable-ASCII path below the working directory: tar.exe receives it unchanged. */
function asciiInside(relative: string): boolean {
  return (
    /^[\x20-\x7e]+$/.test(relative) && !relative.startsWith('..') && !win32.isAbsolute(relative)
  );
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
