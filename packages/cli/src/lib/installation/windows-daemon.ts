import { spawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { controlResponseSchema } from '@puddle/shared';
import { checkIpcProof, ipcChallenge, ipcPath, jsonLines } from '@puddle/shared/node';
import {
  deleteEnv,
  disableCurrentDirectorySearch,
  getEnv,
  isPidAlive,
  killProcessTree,
  listWindowsProcesses,
  setEnv,
  type WindowsProcess,
} from '@puddle/shared/node/platform';
import { sleep } from '../transport/net.js';
import { CliError, type Logger, silentLogger } from '../types.js';

/**
 * Windows supervision (docs/windows.md, decision 6): the `detached`
 * supervisor. There is no service manager, so the CLI or the desktop app
 * starts the versioned runtime itself — `bin\versions\<V>\bin\node.exe` on
 * `daemon\puddled.mjs`, never `process.execPath`, which may be Electron —
 * detached and windowless, with output appended to logs\puddled.*.log.
 *
 * Never compete: the daemon's private control pipe is the single-instance
 * arbiter (a second daemon exits with "already active" before it opens the
 * database), and the daemon holds it until the database is closed. Stops use
 * the authenticated `shutdown` request (protocol 25.7) and wait for the pipe
 * to go; only a process whose command line proves it is this home's daemon
 * is ever terminated.
 */

/** Rotated at spawn: nothing else trims a detached daemon's output. */
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 15_000;
/** How long a starting daemon may take to serve its pipe before it is terminated. */
const STARTING_GRACE_MS = 15_000;
const TERMINATE_GRACE_MS = 5_000;

/**
 * Orchestration variables a supervisor's clean environment would not carry.
 * A daemon started from inside an agent session must not hand them to the
 * agents it spawns (CLAUDE.md); the rest are this CLI's own markers.
 */
const INHERITED_MARKERS = [
  'CLAUDECODE',
  'PUDDLE_COCKPIT_CHILD',
  'PUDDLE_REFRESH_ID',
  'PUDDLE_INTERNAL_REFRESH',
  'ELECTRON_RUN_AS_NODE',
];

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

/**
 * The environment a detached daemon starts with. An overridden PUDDLE_HOME
 * is passed on absolute: the daemon runs in the user's home directory, where
 * a relative one would name another home. The search of a child's working
 * directory for a bare program name is off from the daemon's first
 * instruction, whichever app launched it.
 */
export function daemonEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  home?: string,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^CLAUDE_CODE_/i.test(key)) delete env[key];
  }
  for (const name of INHERITED_MARKERS) deleteEnv(env, name, 'win32');
  if (home !== undefined && getEnv(env, 'PUDDLE_HOME', 'win32') !== undefined) {
    setEnv(env, 'PUDDLE_HOME', win32.resolve(home), 'win32');
  }
  disableCurrentDirectorySearch(env, 'win32');
  return env;
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

function openRotated(file: string): number {
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // Absent, or held open by an exiting daemon: keep appending.
  }
  return openSync(file, 'a');
}

/**
 * What holds the home's control pipe. `daemon`: a server that proves it can
 * read the home (one still starting answers `unavailable`, with its proof).
 * `foreign`: one that answers without that proof, so it is not this home's
 * daemon, whatever it says: another account's process squatting a name that
 * an earlier run used. `unknown`: no answer, or no access to the pipe (an
 * elevated daemon as well as another account's); it is waited for, never
 * replaced (docs/windows.md, decision 6).
 */
export type ControlPipeState = 'absent' | 'daemon' | 'foreign' | 'unknown';

/** Probe with a challenged `open`; a lease the daemon grants ends with the probe's connection. */
export function controlPipeState(home: string, timeoutMs = 3000): Promise<ControlPipeState> {
  const challenge = ipcChallenge();
  return new Promise((resolve) => {
    const socket = connect(ipcPath(home, 'host'));
    let settled = false;
    const settle = (state: ControlPipeState) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(timeoutMs, () => settle('unknown'));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      settle(err.code === 'ENOENT' ? 'absent' : 'unknown'),
    );
    socket.once('close', () => settle('unknown'));
    jsonLines(
      socket,
      (value) => {
        const reply = controlResponseSchema.safeParse(value);
        const proof = reply.success && 'proof' in reply.data ? reply.data.proof : undefined;
        settle(checkIpcProof(home, 'host', challenge, proof) ? 'daemon' : 'foreign');
      },
      () => settle('foreign'),
    );
    socket.once('connect', () => socket.write(JSON.stringify({ t: 'open', challenge }) + '\n'));
  });
}

/** Whether a daemon may hold the home's control pipe: neither nothing nor a proven impostor. */
export async function controlPipePresent(home: string): Promise<boolean> {
  const state = await controlPipeState(home);
  return state === 'daemon' || state === 'unknown';
}

/**
 * `unsupported`: a pre-25.7 daemon (`invalid_control`). `unavailable`: one
 * still starting (`unavailable`), or one that does not answer. `foreign`: a
 * server without this home's proof (see ControlPipeState), never a daemon.
 */
export type ShutdownOutcome = 'stopping' | 'unsupported' | 'unavailable' | 'absent' | 'foreign';

/** Ask the home's daemon to stop over its private control pipe. */
export function requestDaemonShutdown(home: string, timeoutMs = 5000): Promise<ShutdownOutcome> {
  const challenge = ipcChallenge();
  return new Promise((resolve) => {
    const socket = connect(ipcPath(home, 'host'));
    let settled = false;
    const settle = (outcome: ShutdownOutcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(timeoutMs, () => settle('unavailable'));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      settle(err.code === 'ENOENT' ? 'absent' : 'unavailable'),
    );
    socket.once('close', () => settle('unavailable'));
    jsonLines(
      socket,
      (value) => {
        const message = controlResponseSchema.safeParse(value);
        if (!message.success) return settle('foreign');
        const reply = message.data;
        const proof = 'proof' in reply ? reply.proof : undefined;
        if (!checkIpcProof(home, 'host', challenge, proof)) return settle('foreign');
        if (reply.t === 'shutting_down') return settle('stopping');
        settle(
          reply.t === 'error' && reply.code === 'invalid_control' ? 'unsupported' : 'unavailable',
        );
      },
      () => settle('foreign'),
    );
    socket.once('connect', () => socket.write(JSON.stringify({ t: 'shutdown', challenge }) + '\n'));
  });
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

/** Pids of this home's running daemons, by command line. */
export async function homeDaemonPids(
  home: string,
  list: () => Promise<readonly WindowsProcess[]> = listWindowsProcesses,
): Promise<number[]> {
  return (await list()).filter((p) => isHomeDaemon(p, home)).map((p) => p.pid);
}

export interface StopOptions {
  logger?: Logger;
  /** Seams for tests. */
  list?: () => Promise<readonly WindowsProcess[]>;
  graceMs?: number;
  startingGraceMs?: number;
  terminateGraceMs?: number;
}

/**
 * Stop whatever daemon serves this home: graceful shutdown first — waiting
 * for one that is still starting to be able to answer — then termination
 * of identity-checked processes only. Resolves once the control pipe is gone
 * (the daemon holds it until its database is closed) and every matching
 * process has exited; throws if one cannot be stopped.
 */
export async function stopWindowsDaemon(home: string, opts: StopOptions = {}): Promise<void> {
  const logger = opts.logger ?? silentLogger;
  const list = opts.list ?? listWindowsProcesses;
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
    await killProcessTree(pid, { platform: 'win32' });
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
