import { execFile } from 'node:child_process';
import { system32Path, type Environment } from './environment.js';
import {
  windowsDescendantsOf,
  windowsProcessTree,
  type ProcessTreeRoot,
  type WindowsProcess,
  type WindowsProcessListOptions,
} from './windows-process-table.js';

/**
 * Whether `pid` names a live process, by a signal-0 probe. POSIX keeps the
 * rule every existing caller applies (the CLI registry, the desktop askpass
 * helper and `kill -0` over SSH): any failure, EPERM included, reads as not
 * alive. On Windows EPERM means the process exists but is another user's or
 * protected, so it is alive. Pids that are not positive integers are never
 * alive: signal 0 to 0 or -1 would probe a process group instead.
 */
export function isPidAlive(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A Windows process table: `listWindowsProcesses`, or a test's stand-in. */
export type WindowsProcessSource = (
  options?: WindowsProcessListOptions,
) => Promise<readonly WindowsProcess[]>;

export interface KillProcessTreeOptions {
  platform?: NodeJS.Platform;
  /** Bound on waiting for taskkill.exe; 5 s by default. */
  timeoutMs?: number;
  /** Locates `%SystemRoot%`; `process.env` by default. */
  env?: Environment;
  /**
   * Windows: stop the tree the process table shows (stopWindowsProcessTree)
   * rather than the one `taskkill /T` follows, which cannot reach a
   * descendant whose parent has exited. When the table cannot be read this
   * stops nothing: by then `pid` may name another process, so `taskkill /T`
   * on it is no fallback.
   */
  processes?: WindowsProcessSource;
  /** With `processes`: what is known about the root (see windowsProcessTree). */
  root?: Omit<ProcessTreeRoot, 'pid'>;
}

/**
 * Forcibly stops `pid` and its descendants, resolving whether or not the
 * process existed. Windows runs `taskkill.exe /PID <pid> /T /F` from
 * System32, or with `processes` stops the process table's tree. POSIX sends
 * SIGKILL to the process group `pid` leads and then to `pid` itself, which
 * only reaches descendants that stayed in that group; existing POSIX callers
 * keep their own signal sequences.
 */
export function killProcessTree(pid: number, opts: KillProcessTreeOptions = {}): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.reject(new RangeError(`Invalid process id: ${pid}`));
  }
  if ((opts.platform ?? process.platform) !== 'win32') {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // Already gone, or not a group leader.
      }
    }
    return Promise.resolve();
  }
  if (opts.processes) {
    return stopWindowsProcessTree(pid, { processes: opts.processes, root: opts.root }).then(
      () => undefined,
      () => undefined,
    );
  }
  return taskkill(pid, opts);
}

function taskkill(pid: number, opts: KillProcessTreeOptions): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      system32Path('taskkill.exe', opts.env),
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: opts.timeoutMs ?? 5_000 },
      // Exit status 128 means no such process: the outcome callers want.
      () => resolve(),
    );
  });
}

export interface StopWindowsProcessTreeOptions {
  processes: WindowsProcessSource;
  /** What is known about the root beyond its pid (see windowsProcessTree). */
  root?: Omit<ProcessTreeRoot, 'pid'>;
  /**
   * Members of the tree seen in an earlier table: those still running are
   * stopped too, with their descendants, though a parent between them and
   * the root has exited since.
   */
  known?: readonly WindowsProcess[];
  /**
   * When `known` was read. The children of a member that has exited since
   * count only when they were created by then: later, its pid may have
   * named another process that has exited as well. Without it they count up
   * to the creation of a later holder of the pid.
   */
  knownAtMs?: number;
  /** This process's clock; `Date.now` by default. */
  now?: () => number;
  /** A snapshot already read for this stop (a fresh one is read otherwise). */
  table?: readonly WindowsProcess[];
  /** Ends one process; TerminateProcess through `process.kill` by default. */
  terminate?: (pid: number) => void;
}

/**
 * Stops a Windows process tree as the process table shows it
 * (windowsProcessTree): unlike `taskkill /T`, this reaches the children of
 * a root, or of any member, that has already exited, while a later holder of
 * a dead process's pid keeps its own children. Parents end before their
 * children, so none can start a replacement; then the table is read again
 * for children started in between, at most twice more, counting a stopped
 * process's children only up to when it was stopped. This process is never
 * stopped. Resolves with the processes it ended; rejects when the table
 * cannot be read.
 */
export async function stopWindowsProcessTree(
  pid: number,
  opts: StopWindowsProcessTreeOptions,
): Promise<WindowsProcess[]> {
  const terminate =
    opts.terminate ??
    ((target: number) => {
      process.kill(target);
    });
  const now = opts.now ?? Date.now;
  const known = opts.known ?? [];
  const identity = (entry: WindowsProcess) => `${entry.pid}@${entry.createdAtMs}`;
  const table = opts.table ?? (await opts.processes({ fresh: true }));
  const running = new Set(table.map(identity));
  const stopped: WindowsProcess[] = [];
  /** When each stopped process was stopped: its children are not created after. */
  const stoppedAt = new Map<string, number>();
  const exitedBefore = (parent: WindowsProcess) =>
    stoppedAt.get(identity(parent)) ?? opts.knownAtMs;
  let targets = [
    ...windowsProcessTree(table, { ...opts.root, pid }),
    ...known.filter((entry) => running.has(identity(entry))),
    ...windowsDescendantsOf(table, known, exitedBefore),
  ];
  for (let round = 0; round < 3; round++) {
    const fresh = targets.filter((entry) => !stoppedAt.has(identity(entry)));
    if (fresh.length === 0) break;
    for (const target of fresh) {
      if (stoppedAt.has(identity(target))) continue;
      stoppedAt.set(identity(target), now());
      if (target.pid === process.pid) continue;
      try {
        terminate(target.pid);
      } catch {
        // Exited meanwhile, or another account's.
      }
      stopped.push(target);
    }
    if (round === 2) break;
    targets = windowsDescendantsOf(
      await opts.processes({ fresh: true }),
      [...stopped, ...known],
      exitedBefore,
    );
  }
  return stopped;
}
