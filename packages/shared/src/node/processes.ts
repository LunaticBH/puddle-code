import type { ChildProcess } from 'node:child_process';
import {
  listWindowsProcesses,
  windowsDescendantsOf,
  windowsProcessTree,
  type ProcessTreeRoot,
  type WindowsProcess,
  type WindowsProcessListOptions,
} from './windows-process-table.js';
import { isGuiSubsystem, peSubsystem } from './windows-subsystem.js';

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

/** A process's PE subsystem (2 for a GUI programme), or null when its image cannot be read. */
export type WindowsSubsystemSource = (entry: WindowsProcess) => Promise<number | null>;

/** The subsystem of a process's image, from the path the process table gives (peSubsystem). */
export function imageSubsystem(entry: WindowsProcess): Promise<number | null> {
  return entry.executablePath ? peSubsystem(entry.executablePath) : Promise.resolve(null);
}

export interface KillProcessTreeOptions {
  platform?: NodeJS.Platform;
  /** Windows: the process table to read; the shared worker's (listWindowsProcesses) by default. */
  processes?: WindowsProcessSource;
  /**
   * Windows: what is known about the root beyond its pid (see
   * windowsProcessTree). Without it, whichever process holds the pid when
   * the table is read is taken for the root.
   */
  root?: Omit<ProcessTreeRoot, 'pid'>;
  /**
   * Windows: ends the root through a handle that cannot name another
   * process, such as `ChildProcess.kill` on a child of this process (libuv
   * holds its handle until its exit is reaped). Used for the root in place
   * of its pid, and all that ends when the table cannot be read.
   */
  endRoot?: () => void;
  /** Windows: each process's PE subsystem; imageSubsystem by default. Tests substitute. */
  subsystem?: WindowsSubsystemSource;
  /** Windows: ends one process by pid; TerminateProcess through `process.kill` by default. */
  terminate?: (pid: number) => void;
}

/**
 * Forcibly stops `pid` and its descendants, resolving whether or not the
 * process existed. POSIX sends SIGKILL to the process group `pid` leads and
 * then to `pid` itself, which only reaches descendants that stayed in that
 * group; existing POSIX callers keep their own signal sequences.
 *
 * Windows (docs/windows.md, decision 8) stops the tree the process table
 * shows, through creation-time-consistent links only
 * (stopWindowsProcessTree): never a GUI programme below the root, nor
 * anything below one, nor a process whose image cannot be read. It never
 * runs `taskkill /T`, which follows parent pids that a reused pid may name.
 * When the table cannot be read, only `endRoot` ends anything. Unlike a
 * POSIX process group, the tree includes console processes that were
 * started detached or in a console of their own.
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
  let rootEnded = false;
  const endRoot = opts.endRoot;
  return stopWindowsProcessTree(pid, {
    processes: opts.processes ?? listWindowsProcesses,
    root: opts.root,
    spareGui: true,
    ...(opts.subsystem ? { subsystem: opts.subsystem } : {}),
    ...(opts.terminate ? { terminate: opts.terminate } : {}),
    ...(endRoot
      ? {
          endRoot: () => {
            rootEnded = true;
            endRoot();
          },
        }
      : {}),
  }).then(
    () => undefined,
    () => {
      // No table to tell the root's descendants by: the root alone, by its handle.
      if (endRoot && !rootEnded) {
        try {
          endRoot();
        } catch {
          // Exited meanwhile.
        }
      }
    },
  );
}

/** The part of a ChildProcess that childProcessTree uses. */
export type SpawnedChild = Pick<ChildProcess, 'pid' | 'kill' | 'once'>;

/** A child of this process, as killProcessTree tells it apart from later holders of its pid. */
export interface ChildProcessTree {
  /** What is known about it now, for windowsProcessTree. */
  root(): Omit<ProcessTreeRoot, 'pid'>;
  /**
   * killProcessTree on it, ending it through its own handle; resolves at
   * once for a child that never started.
   */
  kill(opts?: Omit<KillProcessTreeOptions, 'root' | 'endRoot'>): Promise<void>;
}

/**
 * Records what identifies `child` on Windows: it was created between
 * `startedAtMs` (the clock just before `spawn`) and now (call this just
 * after), and, once it has exited, by when.
 */
export function childProcessTree(child: SpawnedChild, startedAtMs: number): ChildProcessTree {
  const spawnedAtMs = Date.now();
  let exitedAtMs: number | undefined;
  child.once('exit', () => {
    exitedAtMs = Date.now();
  });
  const root = () => ({
    startedAtMs,
    createdBeforeMs: spawnedAtMs,
    ...(exitedAtMs !== undefined ? { exitedAtMs } : {}),
  });
  return {
    root,
    kill: (opts = {}) =>
      child.pid === undefined
        ? Promise.resolve()
        : killProcessTree(child.pid, { ...opts, root: root(), endRoot: () => child.kill() }),
  };
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
  /** Ends the running root in place of `terminate` (a handle that cannot name another process). */
  endRoot?: () => void;
  /**
   * Leave every GUI programme below the root, and everything below it, and
   * every process whose image cannot be read, running; the root's own image
   * never counts. Off by default: the test suites' guards stop everything.
   */
  spareGui?: boolean;
  /** With `spareGui`: each process's PE subsystem; imageSubsystem by default. */
  subsystem?: WindowsSubsystemSource;
}

const identity = (entry: WindowsProcess) => `${entry.pid}@${entry.createdAtMs}`;

/**
 * Of `entries`, those to spare: GUI programmes, and processes whose image
 * cannot be read (which could be one).
 */
async function guiProcesses(
  entries: readonly WindowsProcess[],
  subsystem: WindowsSubsystemSource,
): Promise<Set<string>> {
  const spared = new Set<string>();
  await Promise.all(
    entries.map(async (entry) => {
      const kind = await subsystem(entry).catch(() => null);
      if (kind === null || isGuiSubsystem(kind)) spared.add(identity(entry));
    }),
  );
  return spared;
}

/**
 * Stops a Windows process tree as the process table shows it
 * (windowsProcessTree): unlike `taskkill /T`, this reaches the children of
 * a root, or of any member, that has already exited, while a later holder of
 * a dead process's pid keeps its own children. Parents end before their
 * children, so none can start a replacement; then the table is read again
 * for children started in between, at most twice more, counting a stopped
 * process's children only up to when it was stopped. This process is never
 * stopped, nor, with `spareGui`, a GUI programme below the root or what it
 * started. Resolves with the processes it ended; rejects when the table
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
  const table = opts.table ?? (await opts.processes({ fresh: true }));
  const running = new Set(table.map(identity));
  const stopped: WindowsProcess[] = [];
  /** When each stopped process was stopped: its children are not created after. */
  const stoppedAt = new Map<string, number>();
  const exitedBefore = (parent: WindowsProcess) =>
    stoppedAt.get(identity(parent)) ?? opts.knownAtMs;
  /**
   * What `find` names, less what `spareGui` spares: `find` runs once to
   * learn whose images to read, and again sparing the GUI programmes, which
   * leaves out what is below them too.
   */
  const select = async (
    find: (spare?: (entry: WindowsProcess) => boolean) => WindowsProcess[],
  ): Promise<WindowsProcess[]> => {
    if (!opts.spareGui) return find();
    const spared = await guiProcesses([...find(), ...known], opts.subsystem ?? imageSubsystem);
    return find((entry) => spared.has(identity(entry)));
  };
  let root: WindowsProcess | undefined;
  let targets = await select((spare) => {
    const tree = windowsProcessTree(table, { ...opts.root, pid }, spare);
    // A running root comes first; a dead root's orphans never hold its pid.
    root = tree[0]?.pid === pid ? tree[0] : undefined;
    const parents = spare ? known.filter((entry) => !spare(entry)) : known;
    return [
      ...tree,
      ...parents.filter((entry) => running.has(identity(entry))),
      ...windowsDescendantsOf(table, parents, exitedBefore, spare),
    ];
  });
  for (let round = 0; round < 3; round++) {
    const fresh = targets.filter((entry) => !stoppedAt.has(identity(entry)));
    if (fresh.length === 0) break;
    for (const target of fresh) {
      if (stoppedAt.has(identity(target))) continue;
      stoppedAt.set(identity(target), now());
      if (target.pid === process.pid) continue;
      try {
        if (target === root && opts.endRoot) opts.endRoot();
        else terminate(target.pid);
      } catch {
        // Exited meanwhile, or another account's.
      }
      stopped.push(target);
    }
    if (round === 2) break;
    const later = await opts.processes({ fresh: true });
    targets = await select((spare) =>
      windowsDescendantsOf(
        later,
        [...stopped, ...(spare ? known.filter((entry) => !spare(entry)) : known)],
        exitedBefore,
        spare,
      ),
    );
  }
  return stopped;
}
