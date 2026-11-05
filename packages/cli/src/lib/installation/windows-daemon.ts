import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  controlPipeState,
  daemonEnvironment,
  isPidAlive,
  listWindowsProcesses,
  openRotated,
  requestDaemonShutdown,
  supervisorRequest,
  type ShutdownOutcome,
  type WindowsProcess,
} from '@puddle/shared/node/platform';
import { sleep } from '../transport/net.js';
import { CliError, type Logger, silentLogger } from '../types.js';

export {
  controlPipeState,
  daemonEnvironment,
  requestDaemonShutdown,
  type ControlPipeState,
  type ShutdownOutcome,
} from '@puddle/shared/node/platform';

/**
 * Windows supervision (docs/windows.md, decision 6). The home's resident
 * supervisor (`daemon\supervisor.mjs`, started at logon by its scheduled
 * task, or by a launcher) runs the versioned runtime —
 * `bin\versions\<V>\bin\node.exe` on `daemon\puddled.mjs`, never
 * `process.execPath`, which may be Electron — and restarts it after a crash;
 * see @puddle/shared/node/windows-supervision. A release without the
 * supervisor still runs its daemon directly, detached and windowless
 * (startWindowsDaemon).
 *
 * Never compete: the daemon's private control pipe is the single-instance
 * arbiter (a second daemon exits with "already active" before it opens the
 * database), and the daemon holds it until the database is closed; the
 * supervisor's own pipe does the same for supervisors. Stops end the
 * supervisor first, which would otherwise start the daemon again, then use
 * the authenticated `shutdown` request (protocol 25.7) and wait for the pipe
 * to go; only a process whose command line proves it is this home's daemon
 * or supervisor is ever terminated, and only that process (terminate).
 */

const SHUTDOWN_GRACE_MS = 15_000;
/** How long a starting daemon may take to serve its pipe before it is terminated. */
const STARTING_GRACE_MS = 15_000;
const TERMINATE_GRACE_MS = 5_000;
/** How long a supervisor asked to stop may take to stop its daemon and connector. */
const SUPERVISOR_GRACE_MS = 30_000;

/**
 * Terminates a daemon or supervisor that did not stop, and nothing else:
 * Node ends the children it started itself with it (a supervisor's daemon
 * and connector), and a daemon's pseudoconsoles close with it, which ends
 * what is attached to them, as a hang-up does (docs/windows.md, decision
 * 8). `taskkill /T` would also end what the sessions started that left
 * their consoles, GUI programmes and detached servers among them.
 */
function terminate(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // It exited meanwhile.
  }
}

export interface WindowsRuntime {
  /** `<home>\bin\versions\<V>` */
  dir: string;
  node: string;
  entry: string;
}

export function windowsRuntime(home: string, version: string): WindowsRuntime {
  const dir = win32.join(home, 'bin', 'versions', version);
  return {
    dir,
    node: win32.join(dir, 'bin', 'node.exe'),
    entry: win32.join(dir, 'daemon', 'puddled.mjs'),
  };
}

/** Start the daemon of `version`, detached and windowless; resolves with its pid. */
export async function startWindowsDaemon(
  home: string,
  version: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  // The canonical spelling, so isHomeDaemon recognises the command line later.
  const runtime = windowsRuntime(canonicalHome(home), version);
  const logs = join(home, 'logs');
  mkdirSync(logs, { recursive: true });
  const out = openRotated(join(logs, 'puddled.out.log'));
  const err = openRotated(join(logs, 'puddled.err.log'));
  try {
    const child = spawn(runtime.node, [runtime.entry], {
      // Detached children leave libuv's kill-on-close job, so the daemon
      // outlives this process; windowsHide keeps it (and its console
      // children) from opening windows.
      detached: true,
      windowsHide: true,
      cwd: homedir(),
      stdio: ['ignore', out, err],
      env: daemonEnvironment(opts.env, home),
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('error', (error) =>
        reject(
          new CliError(
            'daemon_start_timeout',
            `could not start puddled ${version}: ${error.message}`,
            'reinstall it with: puddle upgrade daemon',
          ),
        ),
      );
      child.once('spawn', () => resolve(child.pid!));
    });
    child.unref();
    // node.exe is the daemon itself, so this pid is the one runtime.json records.
    writeFileSync(join(home, 'puddled.pid'), `${pid}\n`);
    return pid;
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

/** Whether a daemon may hold the home's control pipe: neither nothing nor a proven impostor. */
export async function controlPipePresent(home: string): Promise<boolean> {
  const state = await controlPipeState(home);
  return state === 'daemon' || state === 'unknown';
}

/**
 * Whether `process` is a daemon of this home: node.exe running
 * `<home>\bin\versions\<V>\daemon\puddled.mjs`. A recycled pid, another
 * user's process (Windows withholds its command line) or a daemon of another
 * home never matches.
 */
export function isHomeDaemon(candidate: WindowsProcess, home: string): boolean {
  if (candidate.commandLine === null || candidate.command !== 'node') return false;
  const commandLine = candidate.commandLine.replace(/\//g, '\\').toLowerCase();
  const versions = win32.join(canonicalHome(home), 'bin', 'versions').toLowerCase() + '\\';
  return commandLine.includes(versions) && /\\daemon\\puddled\.mjs\b/.test(commandLine);
}

function canonicalHome(home: string): string {
  try {
    return realpathSync.native(home);
  } catch {
    return win32.resolve(home);
  }
}

/**
 * Whether `process` is a supervisor of this home: node.exe running
 * `<home>\bin\current\daemon\supervisor.mjs` (as the task and launchers
 * start it) or a versioned one. Never a daemon or connector of the home.
 */
export function isHomeSupervisor(candidate: WindowsProcess, home: string): boolean {
  if (candidate.commandLine === null || candidate.command !== 'node') return false;
  const commandLine = candidate.commandLine.replace(/\//g, '\\').toLowerCase();
  const bin = win32.join(canonicalHome(home), 'bin').toLowerCase() + '\\';
  return commandLine.includes(bin) && /\\daemon\\supervisor\.mjs\b/.test(commandLine);
}

/** Pids of this home's running daemons, by command line. */
export async function homeDaemonPids(
  home: string,
  list: () => Promise<readonly WindowsProcess[]> = listWindowsProcesses,
): Promise<number[]> {
  return (await list()).filter((p) => isHomeDaemon(p, home)).map((p) => p.pid);
}

/** Pids of this home's running supervisors, by command line. */
export async function homeSupervisorPids(
  home: string,
  list: () => Promise<readonly WindowsProcess[]> = listWindowsProcesses,
): Promise<number[]> {
  return (await list()).filter((p) => isHomeSupervisor(p, home)).map((p) => p.pid);
}

export interface StopOptions {
  logger?: Logger;
  /** Seams for tests. */
  list?: () => Promise<readonly WindowsProcess[]>;
  graceMs?: number;
  startingGraceMs?: number;
  terminateGraceMs?: number;
  supervisorGraceMs?: number;
}

/**
 * End the home's supervisor, which would otherwise restart the daemon a
 * stop ends: asked over its pipe, it stops its daemon and connector itself.
 * One that does not stop in time, or cannot be asked, is terminated, its
 * children with it, only when its command line identifies it
 * (isHomeSupervisor): the pid its pipe reports is waited for, never
 * terminated on that word alone.
 */
export async function stopWindowsSupervisor(home: string, opts: StopOptions = {}): Promise<void> {
  const logger = opts.logger ?? silentLogger;
  const list = opts.list ?? listWindowsProcesses;
  const answer = await supervisorRequest(home, 'shutdown');
  let pids = await homeSupervisorPids(home, list).catch(() => [] as number[]);
  const reported = answer.kind === 'answered' ? answer.state.pid : undefined;
  if (reported !== undefined) {
    logger.info('stopping the Puddle supervisor on this machine');
    const asked = [...new Set([reported, ...pids])];
    if (await supervisorsGone(home, asked, opts.supervisorGraceMs ?? SUPERVISOR_GRACE_MS)) return;
    pids = await homeSupervisorPids(home, list).catch(() => pids);
  } else if (pids.length === 0) {
    return;
  }
  for (const pid of pids) {
    logger.warn(`the Puddle supervisor (pid ${pid}) did not stop — terminating it`);
    terminate(pid);
  }
  if (await supervisorsGone(home, pids, opts.terminateGraceMs ?? TERMINATE_GRACE_MS)) return;
  // Only an answering supervisor gets here without identified pids.
  const named = pids.length > 0 ? pids.join(', ') : String(reported);
  throw new CliError(
    'daemon_unreachable',
    'could not stop the Puddle supervisor on this machine',
    `stop it in Task Manager (pid ${named}), then retry`,
  );
}

async function supervisorsGone(home: string, pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = pids.some((pid) => isPidAlive(pid, 'win32'));
    const served = (await supervisorRequest(home, 'status', 1000)).kind;
    if (!alive && served !== 'answered' && served !== 'unavailable') return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/**
 * Stop whatever daemon serves this home: its supervisor first, then
 * graceful shutdown — waiting for a daemon that is still starting to be able
 * to answer — then termination of identity-checked processes only. Resolves
 * once the control pipe is gone (the daemon holds it until its database is
 * closed) and every matching process has exited; throws if one cannot be
 * stopped.
 */
export async function stopWindowsDaemon(home: string, opts: StopOptions = {}): Promise<void> {
  const logger = opts.logger ?? silentLogger;
  const list = opts.list ?? listWindowsProcesses;
  await stopWindowsSupervisor(home, opts);
  const starting = Date.now() + (opts.startingGraceMs ?? STARTING_GRACE_MS);
  let outcome: ShutdownOutcome;
  // A daemon that is stopping, starting, or wedged before it served its pipe
  // is still found by its command line.
  let pids: number[];
  for (;;) {
    outcome = await requestDaemonShutdown(home);
    pids = await homeDaemonPids(home, list).catch(() => [] as number[]);
    // An impostor's pipe hides no daemon of this home: only identified pids count.
    const noPipe = outcome === 'absent' || outcome === 'foreign';
    if (noPipe && pids.length === 0) return clearPidFile(home);
    const answerable = outcome === 'unavailable' || (noPipe && pids.length > 0);
    if (!answerable || Date.now() >= starting) break;
    await sleep(500);
  }
  if (outcome === 'stopping') {
    logger.info('stopping puddled on this machine');
    if (await stopped(home, pids, opts.graceMs ?? SHUTDOWN_GRACE_MS)) return clearPidFile(home);
    pids = await homeDaemonPids(home, list).catch(() => pids);
  }
  for (const pid of pids) {
    logger.warn(`puddled (pid ${pid}) did not stop cleanly — terminating it`);
    terminate(pid);
  }
  if (await stopped(home, pids, opts.terminateGraceMs ?? TERMINATE_GRACE_MS)) {
    return clearPidFile(home);
  }
  throw new CliError(
    'daemon_unreachable',
    'could not stop the running puddled on this machine',
    pids.length === 0
      ? 'its control pipe is held by a process this CLI cannot identify'
      : `stop it in Task Manager (pid ${pids.join(', ')}), then retry`,
  );
}

/**
 * The pid a home file records: `runtime.json`, which the daemon serving the
 * home's control pipe writes, or `puddled.pid`, which its starter writes.
 */
function recordedPid(home: string, file: 'runtime.json' | 'puddled.pid'): number | null {
  let text: string;
  try {
    text = readFileSync(join(home, file), 'utf8');
  } catch {
    return null;
  }
  let value: unknown;
  if (file === 'puddled.pid') value = Number(text.trim());
  else {
    try {
      value = (JSON.parse(text) as { pid?: unknown }).pid;
    } catch {
      return null;
    }
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** `named`: the home no longer names the pid; `gone`: it is no daemon of this home now. */
export type DaemonPidStop = 'stopped' | 'named' | 'gone';

/**
 * Stop one daemon of this home, by pid, and only while the home still names
 * it (runtime.json or puddled.pid): the daemon an SSH-attached lease started,
 * never the home's supervisor or a daemon another launcher, or the logon
 * task, started meanwhile. The POSIX lease likewise signals only the pid it
 * captured. Graceful first, over the control pipe when runtime.json shows
 * this daemon serves it; then termination of that identified process alone.
 * Resolves `named` or `gone`, touching nothing, when it is no longer that
 * home's daemon.
 */
export async function stopWindowsDaemonPid(
  home: string,
  pid: number,
  opts: StopOptions = {},
): Promise<DaemonPidStop> {
  const logger = opts.logger ?? silentLogger;
  const list = opts.list ?? listWindowsProcesses;
  const serving = recordedPid(home, 'runtime.json') === pid;
  if (!serving && recordedPid(home, 'puddled.pid') !== pid) return 'named';
  // A recycled pid, or a process this home does not run, is never stopped.
  const identified = (await homeDaemonPids(home, list).catch(() => [] as number[])).includes(pid);
  if (!identified) {
    clearPidFileOf(home, pid);
    return 'gone';
  }
  if (serving && (await requestDaemonShutdown(home)) === 'stopping') {
    logger.info('stopping puddled');
    if (await pidGone(pid, opts.graceMs ?? SHUTDOWN_GRACE_MS)) {
      clearPidFileOf(home, pid);
      return 'stopped';
    }
  }
  logger.warn(`puddled (pid ${pid}) did not stop cleanly — terminating it`);
  terminate(pid);
  if (await pidGone(pid, opts.terminateGraceMs ?? TERMINATE_GRACE_MS)) {
    clearPidFileOf(home, pid);
    return 'stopped';
  }
  throw new CliError(
    'daemon_unreachable',
    `could not stop puddled (pid ${pid})`,
    `stop it in Task Manager (pid ${pid}), then retry`,
  );
}

async function pidGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isPidAlive(pid, 'win32')) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/** puddled.pid goes only while it still names `pid`. */
function clearPidFileOf(home: string, pid: number): void {
  if (recordedPid(home, 'puddled.pid') === pid) clearPidFile(home);
}

async function stopped(home: string, pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = pids.some((pid) => isPidAlive(pid, 'win32'));
    if (!alive && !(await controlPipePresent(home))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

function clearPidFile(home: string): void {
  rmSync(join(home, 'puddled.pid'), { force: true });
}
