import {
  windowsDescendantsOf,
  windowsProcessTree,
  type WindowsProcess,
  type WindowsProcessSource,
} from '@puddle/shared/node/platform';
import {
  sharedConptyJobs,
  type ClassifiedProcess,
  type ConsoleInspector,
} from '../pty/conpty-jobs.js';
import { endConsole } from '../pty/conpty-teardown.js';
import {
  clearPtyRoots,
  conptyRootBounds,
  readPtyRoots,
  type PtyRootRecord,
} from '../pty/pty-roots.js';
import type { SupervisedChild } from './windows-supervisor.js';

export interface ReapDaemonDeps {
  processes: WindowsProcessSource;
  /** The daemon's record of its live ConPTYs (pty/pty-roots.ts). */
  rootsFile: string;
  /**
   * The ConPTY helper (pty/conpty-jobs.ts) that names, holds and ends
   * processes; this process's shared one by default. Without one (null, or
   * where PowerShell cannot run it) nothing is ended: nothing tells a
   * console programme from a GUI programme or a detached process.
   */
  consoles?: ConsoleInspector | null;
}

/**
 * How long a ConPTY root may outlive its daemon: Windows gives a console
 * process 5 s to handle the close of its console before ending it.
 */
const CONSOLE_CLOSE_MS = 5000;

/** Between the daemon's clock and the creation times Windows records. */
const CLOCK_SLACK_MS = 100;

/**
 * Stops what an exited Windows daemon left running, resolving with how many
 * processes that was, by the rule its PTYs' teardown follows (docs/windows.md,
 * decision 8): a session's end ends what is attached to its console, and
 * never a GUI programme or a process that left the console.
 *
 * A dead daemon's pseudoconsoles close with it, and Windows ends what is
 * attached to them; for each console host it recorded that still runs (it
 * is the one recorded: pid, creation time, headless, the daemon's child),
 * this ends what is still attached to it, then the host. A console host that
 * has gone took its processes with it. For a PTY whose host was never told
 * apart, whose attachment can no longer be read, it ends instead the
 * console programmes below its root that have a console (never a GUI
 * programme, a detached process, or anything they started) and were created
 * before the daemon exited and before the root did; a later holder of the
 * root's pid keeps its own children. Then, as systemd stops a unit's
 * control group, the daemon's own children (not its PTYs' roots and hosts)
 * and their descendants, by the same rule.
 */
export async function reapWindowsDaemon(
  daemon: Pick<SupervisedChild, 'pid' | 'startedAtMs'>,
  exitedAtMs: number,
  deps: ReapDaemonDeps,
): Promise<number> {
  // Another daemon's record (one that serves the home now) stays as it is.
  const roots = readPtyRoots(deps.rootsFile, daemon.pid);
  const consoles = deps.consoles === undefined ? sharedConptyJobs() : deps.consoles;
  const helper = consoles && (await consoles.ready()) ? consoles : null;
  let count = 0;
  try {
    if (helper === null) return 0;
    const untold: PtyRootRecord[] = [];
    for (const root of roots ?? []) {
      if (!root.host) {
        untold.push(root);
        continue;
      }
      const held = await helper.adopt({ ...root.host, parentPid: daemon.pid });
      if (!held) continue;
      try {
        // Never attached to: it is closing, and its close would end the helper.
        count += (await endConsole(root.pid, held, { root: true, host: true, attach: false }))
          .ended;
      } finally {
        held.release();
      }
    }
    const targets = belowDaemon(await deps.processes({ fresh: true }), daemon, exitedAtMs, {
      untold,
      roots: roots ?? [],
    });
    count += await endConsolePrograms(helper, targets);
    return count;
  } finally {
    if (roots !== null) clearPtyRoots(deps.rootsFile);
  }
}

/**
 * What the process table leads to from a dead daemon: the trees below the
 * roots in `untold` and below the daemon's own children, parents first,
 * each created before the daemon exited.
 */
export function belowDaemon(
  table: readonly WindowsProcess[],
  daemon: Pick<SupervisedChild, 'pid' | 'startedAtMs'>,
  exitedAtMs: number,
  options: { untold: readonly PtyRootRecord[]; roots: readonly PtyRootRecord[] },
): WindowsProcess[][] {
  const createdBefore = exitedAtMs + CLOCK_SLACK_MS;
  const trees: WindowsProcess[][] = [];
  for (const root of options.untold) {
    const bounds = conptyRootBounds(root);
    trees.push(
      windowsProcessTree(table, {
        pid: root.pid,
        ...bounds,
        // A recorded root ran when the daemon did: a holder of its pid
        // created after the daemon exited is another process, and so is the
        // parent of one created after the root exited.
        createdBeforeMs: Math.min(bounds.createdBeforeMs, exitedAtMs),
        exitedBeforeMs: Math.min(root.exitedAtMs ?? Infinity, exitedAtMs + CONSOLE_CLOSE_MS),
      }).filter((entry) => entry.createdAtMs !== null && entry.createdAtMs <= createdBefore),
    );
  }
  if (daemon.startedAtMs === undefined) return trees;
  const from = daemon.startedAtMs - CLOCK_SLACK_MS;
  const isRoot = (entry: WindowsProcess) =>
    options.roots.some((root) => {
      const bounds = conptyRootBounds(root);
      return (
        root.pid === entry.pid &&
        entry.createdAtMs !== null &&
        entry.createdAtMs >= bounds.startedAtMs - CLOCK_SLACK_MS &&
        entry.createdAtMs <= bounds.createdBeforeMs + CLOCK_SLACK_MS
      );
    });
  const isConsoleHost = (entry: WindowsProcess) =>
    entry.name.toLowerCase() === 'conhost.exe' && /--headless/i.test(entry.commandLine ?? '');
  // Its PTYs' roots and hosts are their consoles' (above), with all below them.
  const children = table.filter(
    (entry) =>
      entry.ppid === daemon.pid &&
      entry.pid !== daemon.pid &&
      entry.createdAtMs !== null &&
      entry.createdAtMs >= from &&
      entry.createdAtMs <= createdBefore &&
      !isRoot(entry) &&
      !isConsoleHost(entry),
  );
  trees.push(
    [...children, ...windowsDescendantsOf(table, children)].filter(
      (entry) => entry.createdAtMs !== null && entry.createdAtMs <= createdBefore,
    ),
  );
  return trees;
}

/**
 * Of `tree` (parents first) as the helper classified it, the processes to
 * end: console programmes with a console. A GUI programme, a process with no
 * console (detached) or one the helper could not say has one, and
 * everything below them, are spared; so is whatever no longer runs as it
 * was created.
 */
export function consolePrograms(
  tree: readonly WindowsProcess[],
  classified: readonly ClassifiedProcess[],
): ClassifiedProcess[] {
  const key = (entry: { pid: number; createdAtMs: number | null }) =>
    `${entry.pid}@${entry.createdAtMs}`;
  const factOf = (entry: WindowsProcess) =>
    classified.find(
      (fact) =>
        fact.pid === entry.pid &&
        entry.createdAtMs !== null &&
        Math.abs(fact.createdAtMs - entry.createdAtMs) <= 1,
    );
  const spared = new Set<string>();
  const targets: ClassifiedProcess[] = [];
  for (const entry of tree) {
    const parent = tree.find(
      (other) =>
        other.pid === entry.ppid &&
        other !== entry &&
        other.createdAtMs !== null &&
        entry.createdAtMs !== null &&
        other.createdAtMs <= entry.createdAtMs,
    );
    const fact = factOf(entry);
    if ((parent && spared.has(key(parent))) || (fact && (fact.gui || fact.consoleHost <= 0))) {
      spared.add(key(entry));
      continue;
    }
    if (fact) targets.push(fact);
  }
  return targets;
}

/** Ends each tree's console programmes (consolePrograms), held by the helper. */
async function endConsolePrograms(
  helper: ConsoleInspector,
  trees: readonly WindowsProcess[][],
): Promise<number> {
  const all = trees.flat();
  if (all.length === 0) return 0;
  const result = await helper.classify(
    all.flatMap((entry) =>
      entry.createdAtMs === null ? [] : [{ pid: entry.pid, createdAtMs: entry.createdAtMs }],
    ),
  );
  if (!result) return 0;
  try {
    const keys = trees.flatMap((tree) =>
      consolePrograms(tree, result.processes).map((fact) => fact.key),
    );
    return keys.length === 0 ? 0 : await result.console.terminate([...new Set(keys)]);
  } finally {
    result.console.release();
  }
}
