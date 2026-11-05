import {
  isPidAlive,
  listWindowsProcesses,
  stopWindowsProcessTree,
  windowsProcessTree,
  type ProcessTreeRoot,
  type WindowsProcess,
  type WindowsProcessSource,
} from '@puddle/shared/node/platform';
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
 * as the daemon does. So after every ConPTY root's exit the daemon stops
 * what the root left, by the process table's creation-consistent tree, and
 * then the console host, before it reports the exit.
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

/**
 * Stops everything `root` left running, then its ConPTY host. `known` is an
 * earlier snapshotConptyTree: those of its members still running, and their
 * descendants, are stopped too. Resolves with the processes it ended;
 * rejects only when the process table cannot be read.
 *
 * node-pty reports the exit of a root it killed when the pseudoconsole's
 * output closes, which may be before the root has finished exiting: such a
 * root first gets `graceMs` to exit on its own, as closing its console asks
 * it to, before it is stopped with the rest of its tree.
 */
export async function reapConptyTree(
  root: ConptyRoot,
  deps: ConptyTeardownDeps,
  known: readonly WindowsProcess[] = [],
): Promise<WindowsProcess[]> {
  let table = await deps.processes({ fresh: true });
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
    const until = deps.now() + (deps.graceMs ?? 3000);
    while (deps.isAlive(root.pid) && deps.now() < until) await deps.sleep(50);
    // Its creation time tells the root from a process that took its pid since.
    tree = { createdAtMs: holder.createdAtMs };
    table = await deps.processes({ fresh: true });
  } else {
    tree = { startedAtMs: root.startedAtMs, exitedAtMs: deps.now() };
  }
  const stopped = await stopWindowsProcessTree(root.pid, {
    processes: deps.processes,
    root: tree,
    known,
    table,
    terminate: deps.terminate,
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
