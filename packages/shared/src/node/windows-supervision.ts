import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, openSync, realpathSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { deleteEnv, getEnv, setEnv } from './environment.js';
import { disableCurrentDirectorySearch } from './executables.js';
import { readCurrentWindowsUserSid } from './windows-acl.js';
import { supervisorRequest } from './windows-pipes.js';
import {
  createWindowsProcess,
  registerWindowsTask,
  startWindowsTask,
  type WindowsTaskDefinition,
  type WindowsTaskOptions,
  type WindowsTaskRegistration,
  type WindowsTaskStart,
  windowsTaskXml,
} from './windows-tasks.js';

/**
 * Windows daemon supervision (docs/windows.md, decision 6). One per-user
 * scheduled task per home starts the resident supervisor
 * (`daemon\supervisor.mjs`, through the windowless `bin\puddle-hidden.exe`)
 * at logon; the supervisor runs the daemon and, while remote access is
 * supervised, the connector, restarting either after a crash. Launchers
 * start the same supervisor: through the task, then through WMI when the
 * task cannot run (no interactive session), and as a
 * detached child of the launcher only when both are refused. The
 * supervisor's private pipe is the single-instance arbiter, as the daemon's
 * own control pipe is for daemons, so no path ever starts a competitor.
 */

/** A daemon that found its home's control pipe served exits with this (Windows only). */
export const DAEMON_ALREADY_ACTIVE_EXIT = 75;

/** Above this, an output log is rotated when a process opens it. */
export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

/**
 * Orchestration variables a supervisor's clean environment would not carry.
 * A daemon started from inside an agent session must not hand them to the
 * agents it spawns (CLAUDE.md); the rest are the CLI's own markers.
 */
const INHERITED_MARKERS = [
  'CLAUDECODE',
  'PUDDLE_COCKPIT_CHILD',
  'PUDDLE_REFRESH_ID',
  'PUDDLE_INTERNAL_REFRESH',
  'ELECTRON_RUN_AS_NODE',
];

/**
 * The environment a supervised Windows process starts with. An overridden
 * PUDDLE_HOME is passed on absolute: the daemon runs in the user's home
 * directory, where a relative one would name another home. The search of a
 * child's working directory for a bare program name is off from the
 * daemon's first instruction, whichever app launched it.
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

/** Open `file` for appending, first moving a large one aside to `<file>.1`. */
export function openRotated(file: string, maxBytes = LOG_ROTATE_BYTES): number {
  try {
    if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
  } catch {
    // Absent, or held open by an exiting process: keep appending.
  }
  return openSync(file, 'a');
}

/** The home's on-disk spelling, which every launcher and the task share. */
export function canonicalWindowsHome(home: string): string {
  try {
    return realpathSync.native(home);
  } catch {
    return win32.resolve(home);
  }
}

/** `Puddle <16 hex>`: one root-folder task per home, whichever spelling names it. */
export function supervisorTaskName(home: string): string {
  const identity = canonicalWindowsHome(home).toLowerCase();
  return `Puddle ${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

/**
 * Why a home cannot be supervised, if it cannot: Task Scheduler expands
 * `%NAME%` in the command it starts, and a quote or control character would
 * end or split an argument.
 */
export function unsupervisableHome(home: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- Refuse control characters at the trust boundary.
  if (/[%"\u0000-\u001f\u007f]/.test(home)) {
    return `a Puddle home whose path holds %, " or a control character cannot be supervised: ${home}`;
  }
  return undefined;
}

/** One argument for a Windows command line, by the MSVCRT rules (no `"` inside, see above). */
function quoted(value: string): string {
  return `"${value.replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * `bin\puddle-hidden.exe`, built from packages/daemon/src/supervision/puddle-hidden.cs:
 * a GUI-subsystem program, so Windows gives it no console, that runs the
 * command line after its own name with a console that has no window and
 * exits with that program's status. Task Scheduler would give node.exe, a
 * console program, a console window. `conhost.exe --headless` hides one
 * too, but it expands `%NAME%`, exits 0 whatever its program returns, and
 * runs nothing when its standard input is NUL (verified on Windows 11 26200).
 */
export const WINDOWLESS_LAUNCHER = 'puddle-hidden.exe';

/** The supervisor through the `current` junction: an upgrade needs no new task. */
export function supervisorPaths(home: string): { launcher: string; node: string; script: string } {
  const current = win32.join(canonicalWindowsHome(home), 'bin', 'current');
  return {
    launcher: win32.join(current, 'bin', WINDOWLESS_LAUNCHER),
    node: win32.join(current, 'bin', 'node.exe'),
    script: win32.join(current, 'daemon', 'supervisor.mjs'),
  };
}

/** What the launcher runs: node.exe on the supervisor, told its home. */
function supervisorArguments(home: string): string {
  const { node, script } = supervisorPaths(home);
  return [quoted(node), quoted(script), '--home', quoted(canonicalWindowsHome(home))].join(' ');
}

export function supervisorTaskDefinition(home: string, userSid: string): WindowsTaskDefinition {
  const canonical = canonicalWindowsHome(home);
  return {
    description:
      `Puddle: starts the daemon for ${canonical} at logon (and the remote-access ` +
      'connector while it is enabled), restarting them after a crash.',
    userSid,
    command: supervisorPaths(home).launcher,
    arguments: supervisorArguments(home),
    workingDirectory: homedir(),
    // Normal priority: the default (7) runs agents and builds below normal.
    priority: 4,
  };
}

/** The task's command line, for CreateProcess through WMI. */
export function supervisorCommandLine(home: string): string {
  return `${quoted(supervisorPaths(home).launcher)} ${supervisorArguments(home)}`;
}

/**
 * `<home>\remote\supervised`: present while the supervisor runs the
 * connector, the counterpart of POSIX's installed connector unit. Managed
 * `remote enable` creates it and daemon removal deletes it; disabling a
 * profile leaves it, as POSIX leaves the unit, so the connector keeps
 * retrying its queued registration retirements.
 */
export function connectorSupervisedMarker(home: string): string {
  return join(home, 'remote', 'supervised');
}

let userSid: string | undefined;

/** Register (or refresh) the home's task; optionally start it at once. */
export async function registerSupervisorTask(
  home: string,
  opts: WindowsTaskOptions & { start?: boolean; startWaitMs?: number; userSid?: string } = {},
): Promise<WindowsTaskRegistration> {
  const problem = unsupervisableHome(canonicalWindowsHome(home));
  if (problem !== undefined) return { registered: false, disabled: false, error: problem };
  let sid: string;
  try {
    sid = opts.userSid ?? (userSid ??= await readCurrentWindowsUserSid());
  } catch (err) {
    return { registered: false, disabled: false, error: (err as Error).message };
  }
  const name = supervisorTaskName(home);
  try {
    return await registerWindowsTask(
      name,
      windowsTaskXml(name, supervisorTaskDefinition(home, sid)),
      opts,
    );
  } catch (err) {
    return { registered: false, disabled: false, error: (err as Error).message };
  }
}

export interface StartSupervisorOptions extends WindowsTaskOptions {
  /** The per-home task is registered (the `task` supervisor marker). */
  task: boolean;
  /** The result of a start already made with the registration. */
  started?: WindowsTaskStart;
  logger?: { info(line: string): void; warn(line: string): void };
  /** How long each way may take to bring the supervisor's pipe up. */
  waitMs?: number;
  /** Test seam for the last fallback. */
  spawnDetached?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Environment of the detached fallback (WMI and the task use the user's own). */
  env?: NodeJS.ProcessEnv;
}

export type SupervisorStart = 'running' | 'task' | 'process' | 'detached';

const SUPERVISOR_WAIT_MS = 30_000;

/** Until a proven supervisor answers, or `waitMs` passes. */
export async function waitForSupervisor(home: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if ((await supervisorRequest(home, 'status', 2000)).kind === 'answered') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Start the home's supervisor unless one runs: through its task, then WMI,
 * then as a detached child. A late start of an earlier way only meets the
 * supervisor pipe already served and exits, so falling through never leaves
 * two supervisors. Throws when no way brings the supervisor up.
 */
export async function startWindowsSupervisor(
  home: string,
  opts: StartSupervisorOptions,
): Promise<SupervisorStart> {
  const waitMs = opts.waitMs ?? SUPERVISOR_WAIT_MS;
  const info = (line: string) => opts.logger?.info(line);
  if ((await supervisorRequest(home, 'status')).kind === 'answered') return 'running';
  const problem = unsupervisableHome(canonicalWindowsHome(home));
  if (problem !== undefined) throw new Error(problem);
  if (opts.task) {
    let started = opts.started;
    try {
      started ??= await startWindowsTask(supervisorTaskName(home), opts);
    } catch (err) {
      started = { ran: false, state: 'unknown', error: (err as Error).message };
    }
    if (started.ran && (await waitForSupervisor(home, waitMs))) return 'task';
    info(
      started.ran
        ? 'the scheduled task ran, but its supervisor did not come up — starting it directly'
        : `the scheduled task did not run (${started.error ?? `state ${started.state}`}); ` +
            'no desktop session may be logged on — starting the supervisor directly',
    );
  }
  try {
    await createWindowsProcess(supervisorCommandLine(home), homedir(), opts);
    if (await waitForSupervisor(home, waitMs)) return 'process';
    info('the supervisor started through WMI did not come up — starting it from this process');
  } catch (err) {
    info(
      `WMI could not start the supervisor (${(err as Error).message}) — starting it from this process`,
    );
  }
  const { node, script } = supervisorPaths(home);
  const child = (opts.spawnDetached ?? spawn)(
    node,
    [script, '--home', canonicalWindowsHome(home)],
    {
      // Leaves libuv's kill-on-close job, though not an enclosing one.
      detached: true,
      windowsHide: true,
      cwd: homedir(),
      stdio: 'ignore',
      env: daemonEnvironment(opts.env ?? process.env, home),
    },
  );
  const spawned = await new Promise<boolean>((resolve) => {
    child.once('error', () => resolve(false));
    child.once('spawn', () => resolve(true));
  });
  child.unref();
  if (spawned && (await waitForSupervisor(home, waitMs))) return 'detached';
  throw new Error('the Puddle supervisor could not be started on this machine');
}

/**
 * After `remote enable`: the running supervisor re-reads whether it
 * supervises the connector, or a supervisor is started, which reads it on
 * start (and starts the daemon too, as systemd would have it running).
 */
export async function superviseWindowsConnector(
  home: string,
  opts: StartSupervisorOptions,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await supervisorRequest(home, 'reconcile');
    if (answer.kind === 'answered') return;
    if (answer.kind === 'foreign') {
      throw new Error('the supervisor pipe of this Puddle home is held by another program');
    }
    if (answer.kind === 'absent') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  // A supervisor that was busy above may have started before the marker existed.
  if ((await startWindowsSupervisor(home, opts)) === 'running') {
    await supervisorRequest(home, 'reconcile');
  }
}

/**
 * Whether a release tree ships the supervisor and its windowless launcher
 * (older Windows trees ran the daemon directly).
 */
export function shipsSupervisor(versionDir: string): boolean {
  return (
    existsSync(join(versionDir, 'daemon', 'supervisor.mjs')) &&
    existsSync(join(versionDir, 'bin', WINDOWLESS_LAUNCHER))
  );
}
