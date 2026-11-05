import {
  isPidAlive,
  listWindowsProcesses,
  stopWindowsProcessTree,
  windowsProcessTree,
  type ProcessTreeRoot,
  type WindowsProcess,
  type WindowsProcessSource,
} from '@puddle/shared/node/platform';
import type { ConptyJob } from './conpty-jobs.js';
import { conptyRootBounds, type PtyRootRecord } from './pty-roots.js';

/**
 * What a ConPTY leaves behind once its root process has exited, and how the
 * daemon stops it (docs/windows.md, decision 8).
 *
 * POSIX closes a PTY with a hang-up that ends its session's processes.
 * Windows has none: closing a pseudoconsole ends only the processes attached
 * to it, and a root's exit ends nothing at all. A descendant that is
 * detached, started in a console of its own (any hidden Node child, or
 * PowerShell's `Start-Process`) or still attached to the pseudoconsole keeps
 * running, and node-pty closes the pseudoconsole only from `kill()`, never
 * once the root has exited, so its headless `conhost.exe` would run as long
 * as the daemon does. So after every ConPTY root's exit the daemon ends the
 * PTY's job (conpty-jobs.ts), which holds everything the root started
 * whichever of its parents have exited; then it stops what the job could
 * not hold by the process table's creation-consistent tree, and the console
 * host, before it reports the exit.
 */

export interface ConptyRoot extends PtyRootRecord {
  /** node-pty has seen the root exit (it knows the exit code). */
  exited: boolean;
}

export interface ConptyTeardownDeps {
  processes: WindowsProcessSource;
  terminate(pid: number): void;
  isAlive(pid: number): boolean;
  /** The pseudoconsole's owner, whose child its `conhost.exe` is: this process. */
  hostPid: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** How long a root still running when its console closed may take to exit on its own. */
  graceMs?: number;
}

/** The ConPTY host is created inside `pty.spawn`: allow for clock rounding only. */
const HOST_SLACK_MS = 25;

/**
 * The PTY's tree while its root runs, read before Puddle closes its console:
 * a member whose parent exits first is still known to belong to it.
 */
export async function snapshotConptyTree(
  root: Pick<ConptyRoot, 'pid' | 'startedAtMs' | 'spawnedAtMs'>,
  deps: Pick<ConptyTeardownDeps, 'processes'>,
): Promise<WindowsProcess[]> {
  return windowsProcessTree(await deps.processes(), { pid: root.pid, ...conptyRootBounds(root) });
}

export interface ReapConptyOptions {
  /** An earlier snapshotConptyTree: those of its members still running are stopped too. */
  known?: readonly WindowsProcess[];
  /** When `known` was read (see StopWindowsProcessTreeOptions.knownAtMs). */
  knownAtMs?: number;
  /** The PTY's job, when it has one: ended before the process table is read. */
  job?: ConptyJob | null;
  /**
   * The latest time a root still running may have to exit on its own: a
   * stop's deadline, which a SIGKILL brings forward.
   */
  graceEndsBy?: () => number;
}

/**
 * Stops everything `root` left running, then its ConPTY host: first the
 * PTY's job, then, by a fresh process table, the root's tree, the members of
 * `known` still running and their descendants. Resolves with the processes
 * it stopped by the table; rejects only when the table cannot be read.
 *
 * node-pty reports the exit of a root it killed when the pseudoconsole's
 * output closes, which may be before the root has finished exiting: such a
 * root first gets `graceMs` (at most until `graceEndsBy`) to exit on its own,
 * as closing its console asks it to, before it is stopped with the rest. Its
 * pid cannot name another process meanwhile: node-pty holds a handle to the
 * root until it has exited.
 */
export async function reapConptyTree(
  root: ConptyRoot,
  deps: ConptyTeardownDeps,
  options: ReapConptyOptions = {},
): Promise<WindowsProcess[]> {
  let exitedBy = deps.now();
  if (!root.exited) {
    const until = deps.now() + (deps.graceMs ?? 3000);
    const ends = () => Math.min(until, options.graceEndsBy?.() ?? Infinity);
    while (deps.isAlive(root.pid) && deps.now() < ends()) await deps.sleep(50);
  }
  // Whatever is in the job goes at once, however its parents ended.
  if (options.job) await options.job.end();
  if (!root.exited) exitedBy = deps.now();
  const table = await deps.processes({ fresh: true });
  const holder = table.find((entry) => entry.pid === root.pid);
  const bounds = conptyRootBounds(root);
  let tree: Omit<ProcessTreeRoot, 'pid'>;
  if (
    !root.exited &&
    holder !== undefined &&
    holder.createdAtMs !== null &&
    holder.createdAtMs >= bounds.startedAtMs - HOST_SLACK_MS &&
    holder.createdAtMs <= bounds.createdBeforeMs
  ) {
    // Still running (it has no job, or outlived it): stopped with its tree.
    tree = { createdAtMs: holder.createdAtMs };
  } else {
    tree = { startedAtMs: root.startedAtMs, exitedAtMs: exitedBy };
  }
  const stopped = await stopWindowsProcessTree(root.pid, {
    processes: deps.processes,
    root: tree,
    known: options.known,
    knownAtMs: options.knownAtMs,
    table,
    terminate: deps.terminate,
    now: deps.now,
  });
  const hosts = table.filter(
    (entry) =>
      entry.ppid === deps.hostPid &&
      entry.name.toLowerCase() === 'conhost.exe' &&
      /--headless/i.test(entry.commandLine ?? '') &&
      entry.createdAtMs !== null &&
      entry.createdAtMs >= root.startedAtMs - HOST_SLACK_MS &&
      entry.createdAtMs <= root.spawnedAtMs + HOST_SLACK_MS,
  );
  // Two PTYs started within the slack of each other: neither host is known to be this one.
  if (hosts.length === 1) {
    try {
      deps.terminate(hosts[0]!.pid);
      stopped.push(hosts[0]!);
    } catch {
      // It closed on its own meanwhile.
    }
  }
  return stopped;
}

/**
 * When a ConPTY's exit is reported at the latest (PtyManager): set by the
 * first stop request and by the root's own exit, brought forward by a
 * SIGKILL, never put back.
 */
export class ExitDeadline {
  private at = Infinity;
  private readonly wakers = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The deadline, Infinity while none is set. */
  get ms(): number {
    return this.at;
  }

  /** At most `ms` from now. */
  within(ms: number): void {
    const at = this.now() + ms;
    if (at >= this.at) return;
    this.at = at;
    for (const wake of [...this.wakers]) wake();
  }

  /** Resolves with `work`'s value, or with `late` when the deadline passes first. */
  race<T>(work: Promise<T>, late: T): Promise<T> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (value: T) => {
        clearTimeout(timer);
        this.wakers.delete(arm);
        resolve(value);
      };
      const arm = () => {
        clearTimeout(timer);
        const left = this.at - this.now();
        if (left <= 0) done(late);
        else if (Number.isFinite(left)) timer = setTimeout(arm, left);
      };
      this.wakers.add(arm);
      arm();
      work.then(done, () => done(late));
    });
  }
}

/** This process's table, clock and TerminateProcess. */
export const conptyTeardownDeps: ConptyTeardownDeps = {
  processes: (options) => listWindowsProcesses(options),
  terminate: (pid) => {
    process.kill(pid);
  },
  isAlive: (pid) => isPidAlive(pid, 'win32'),
  hostPid: process.pid,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
