import {
  windowsProcessTree,
  type WindowsProcess,
  type WindowsProcessSource,
} from '@puddle/shared/node/platform';
import {
  sharedConptyJobs,
  type ClassifiedProcess,
  type ConptyConsole,
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
  /**
   * How long after the daemon's exit a PTY's root may handle its console's
   * close; CONSOLE_CLOSE_MS by default (tests shorten it).
   */
  consoleCloseMs?: number;
}

/**
 * How long a ConPTY root may outlive its daemon: Windows gives a console
 * process 5 s to handle the close of its console before ending it.
 */
const CONSOLE_CLOSE_MS = 5000;

/** Between the daemon's clock and the creation times Windows records. */
const CLOCK_SLACK_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stops what an exited Windows daemon left running, resolving with how many
 * processes that was, by the rule its PTYs' teardown follows (docs/windows.md,
 * decision 8): a session's end ends what is attached to its console, and
 * never a GUI programme, what one started, or a process that left the
 * console (detached, or in a console of its own).
 *
 * A dead daemon's pseudoconsoles close with it, and Windows ends what is
 * attached to them; for each console host it recorded that still runs (it
 * is the one recorded: pid, creation time, headless, the daemon's child),
 * this ends what is still attached to it, then the host. For a PTY whose
 * host has gone, attachment can no longer be read through it; this ends
 * instead the console programmes below its root, created before the daemon
 * exited and before the root did, that name that host and were created
 * after it (consoleKinds), and nothing that names another. For one whose
 * host was never told apart, it ends those below its root attached to one
 * of the daemon's PTY consoles (a headless console host the daemon created)
 * or to a console that has gone. Never one in a console of its own, a
 * detached one, a GUI programme or anything below those; a later holder of
 * the root's pid keeps its own children. Nothing else is ended: the
 * daemon's other children end with it (Node holds each in a kill-on-close
 * job), and what they started is no PTY console's.
 *
 * A PTY's root goes last, as a hang-up lets a POSIX session leader handle
 * it: once it has exited, or once Windows would have ended it (5 s after
 * the daemon's exit, `consoleCloseMs`), whichever is first. A headless
 * driver ends its CLI's console in that time
 * (agents/headless/terminal-source.ts): ended before, it would leave that
 * console's processes running. Through a recorded host, the root is held as
 * the process whose creation time the daemon recorded; one it never held
 * is ended with the rest, at once. Below a root whose host is not known,
 * the root is the process table's holder of its pid created within its
 * spawn (belowRoots), held as the helper classified it.
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
  const closedBy = exitedAtMs + (deps.consoleCloseMs ?? CONSOLE_CLOSE_MS);
  try {
    if (helper === null || roots === null) return 0;
    const adopted = await Promise.all(
      roots.map((root) =>
        root.host
          ? helper.adopt({
              ...root.host,
              parentPid: daemon.pid,
              // Not one that had exited: its pid may be another process's.
              ...(root.createdAtMs !== undefined && root.exitedAtMs === undefined
                ? { root: { pid: root.pid, createdAtMs: root.createdAtMs } }
                : {}),
            })
          : null,
      ),
    );
    const untold = roots.filter((_, index) => !adopted[index]);
    const told = adopted.map(async (held, index) => {
      if (!held) return 0;
      try {
        return await endRecordedConsole(roots[index]!.pid, held, closedBy);
      } finally {
        held.release();
      }
    });
    const below = async () => {
      if (untold.length === 0) return 0;
      const trees = belowRoots(await deps.processes({ fresh: true }), exitedAtMs, untold).map(
        (tree, index) => ({ tree, root: untold[index]! }),
      );
      return endConsolePrograms(
        helper,
        trees,
        async () =>
          // Read after the helper said which host each names, so that every live one is in it.
          consoleKinds(await deps.processes({ fresh: true }), daemon, exitedAtMs),
        (facts) => rootsExited(deps.processes, facts, closedBy),
      );
    };
    const counts = await Promise.all([...told, below()]);
    return counts.reduce((sum, each) => sum + each, 0);
  } finally {
    if (roots !== null) clearPtyRoots(deps.rootsFile);
  }
}

/**
 * Ends what is attached to a recorded console the helper holds again
 * (never attached to: it is closing, and its close would end the helper):
 * its root last (reapWindowsDaemon), then its host.
 */
async function endRecordedConsole(
  root: number,
  held: ConptyConsole,
  closedBy: number,
): Promise<number> {
  const options = { host: false, attach: false };
  let ended = (await endConsole(root, held, { ...options, root: false })).ended;
  if (held.rootCreatedAtMs !== null) {
    while (Date.now() < closedBy && (await held.alive())?.root === true) await sleep(50);
  }
  ended += (await endConsole(root, held, { ...options, root: true, host: true })).ended;
  return ended;
}

/** Resolves once none of `facts` runs as created (by the process table), or at `closedBy`. */
async function rootsExited(
  processes: WindowsProcessSource,
  facts: readonly ClassifiedProcess[],
  closedBy: number,
): Promise<void> {
  while (Date.now() < closedBy) {
    const table = await processes({ fresh: true });
    const running = facts.some((fact) =>
      table.some(
        (entry) =>
          entry.pid === fact.pid &&
          entry.createdAtMs !== null &&
          Math.abs(entry.createdAtMs - fact.createdAtMs) <= 1,
      ),
    );
    if (!running) return;
    await sleep(100);
  }
}

/**
 * What the process table leads to from the roots in `untold` of a dead
 * daemon: the tree below each, parents first, each created before the
 * daemon exited.
 */
export function belowRoots(
  table: readonly WindowsProcess[],
  exitedAtMs: number,
  untold: readonly PtyRootRecord[],
): WindowsProcess[][] {
  const createdBefore = exitedAtMs + CLOCK_SLACK_MS;
  return untold.map((root) => {
    const bounds = conptyRootBounds(root);
    return windowsProcessTree(table, {
      pid: root.pid,
      ...bounds,
      // A recorded root ran when the daemon did: a holder of its pid
      // created after the daemon exited is another process, and so is the
      // parent of one created after the root exited.
      createdBeforeMs: Math.min(bounds.createdBeforeMs, exitedAtMs),
      exitedBeforeMs: Math.min(root.exitedAtMs ?? Infinity, exitedAtMs + CONSOLE_CLOSE_MS),
    }).filter((entry) => entry.createdAtMs !== null && entry.createdAtMs <= createdBefore);
  });
}

/**
 * What a classified process is attached to: one of the dead daemon's PTY
 * consoles (`pty`), a console that has gone (`gone`: its host no longer
 * runs, or its pid is a later process's), or another console (`other`: one
 * of its own, or one it inherited). Windows leaves a process naming a host
 * that was terminated, whose pid a later host may hold.
 *
 * For a PTY whose console host the daemon recorded (`recorded`), the PTY's
 * processes name that host and were created after it: such a process is on
 * the PTY's console (`pty` while the host still runs as recorded, else
 * `gone`), unless a later process holds the host's pid now and was created
 * no later than it (it may be that one's: `other`). Whatever names another
 * host, gone or not, provably left the PTY's console: `other`.
 *
 * Without one, `pty` is a headless console host the daemon created while it
 * ran, before the process; a host counts only when it was created before
 * the process, or is the host of the console the process created itself
 * (that host's parent, created just after it); one that has gone may have
 * been the PTY's.
 */
export type ConsoleKind = 'pty' | 'gone' | 'other';

type ConsoleFact = Pick<ClassifiedProcess, 'pid' | 'consoleHost' | 'createdAtMs'>;

export function consoleKinds(
  table: readonly WindowsProcess[],
  daemon: Pick<SupervisedChild, 'pid' | 'startedAtMs'>,
  exitedAtMs: number,
): (fact: ConsoleFact, recorded?: PtyRootRecord['host']) => ConsoleKind {
  const from = (daemon.startedAtMs ?? -Infinity) - CLOCK_SLACK_MS;
  return (fact, recorded) => {
    const host = table.find((entry) => entry.pid === fact.consoleHost);
    if (recorded) {
      if (fact.consoleHost !== recorded.pid || fact.createdAtMs < recorded.createdAtMs) {
        return 'other';
      }
      if (!host) return 'gone';
      if (host.createdAtMs !== null && Math.abs(host.createdAtMs - recorded.createdAtMs) <= 1) {
        return 'pty';
      }
      return host.createdAtMs !== null && host.createdAtMs > fact.createdAtMs + 1
        ? 'gone'
        : 'other';
    }
    if (!host || host.createdAtMs === null || host.name.toLowerCase() !== 'conhost.exe') {
      return 'gone';
    }
    const before = host.createdAtMs <= fact.createdAtMs + 1;
    const pty =
      host.ppid === daemon.pid &&
      /--headless/i.test(host.commandLine ?? '') &&
      host.createdAtMs >= from &&
      host.createdAtMs <= exitedAtMs + CLOCK_SLACK_MS;
    if (pty) return before ? 'pty' : 'gone';
    return before || host.ppid === fact.pid ? 'other' : 'gone';
  };
}

/**
 * Of `tree` (parents first) as the helper classified it, the processes to
 * end: console programmes that `kindOf` does not place in another console
 * (consoleKinds). A GUI programme, a process with no console (detached) or
 * one the helper could not say has one, one in a console of its own, and
 * everything below them, are spared; so is whatever no longer runs as it
 * was created. A GUI programme that has exited can no longer be told
 * apart (Windows keeps nothing of an exited process nobody holds): what it
 * started is judged as its own console says, an accepted limitation the
 * PTY teardown shares (conpty-jobs.ts, StartedByGui).
 */
export function consolePrograms(
  tree: readonly WindowsProcess[],
  classified: readonly ClassifiedProcess[],
  kindOf: (fact: ClassifiedProcess) => ConsoleKind,
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
    if (
      (parent && spared.has(key(parent))) ||
      (fact && (fact.gui || fact.consoleHost <= 0 || kindOf(fact) === 'other'))
    ) {
      spared.add(key(entry));
      continue;
    }
    if (fact) targets.push(fact);
  }
  return targets;
}

/**
 * Ends each tree's console programmes (consolePrograms), held by the
 * helper, each by its PTY's recorded console host, if any; a tree's root,
 * still running (the tree's head), only once `rootsExited` resolves.
 */
async function endConsolePrograms(
  helper: ConsoleInspector,
  trees: readonly { tree: readonly WindowsProcess[]; root: PtyRootRecord }[],
  kinds: () => Promise<(fact: ClassifiedProcess, recorded: PtyRootRecord['host']) => ConsoleKind>,
  rootsExited: (roots: readonly ClassifiedProcess[]) => Promise<void>,
): Promise<number> {
  const all = trees.flatMap(({ tree }) => tree);
  if (all.length === 0) return 0;
  const result = await helper.classify(
    all.flatMap((entry) =>
      entry.createdAtMs === null ? [] : [{ pid: entry.pid, createdAtMs: entry.createdAtMs }],
    ),
  );
  if (!result) return 0;
  try {
    const kindOf = await kinds();
    const targets = trees.flatMap(({ tree, root }) => {
      // windowsProcessTree puts a root that still runs first.
      const head = tree[0]?.pid === root.pid ? tree[0] : undefined;
      return consolePrograms(tree, result.processes, (fact) => kindOf(fact, root.host)).map(
        (fact) => ({
          fact,
          root:
            head !== undefined &&
            head.createdAtMs !== null &&
            fact.pid === head.pid &&
            Math.abs(fact.createdAtMs - head.createdAtMs) <= 1,
        }),
      );
    });
    const keys = (list: typeof targets) => [...new Set(list.map(({ fact }) => fact.key))];
    const rest = targets.filter((target) => !target.root);
    const roots = targets.filter((target) => target.root);
    let count = rest.length === 0 ? 0 : await result.console.terminate(keys(rest));
    if (roots.length > 0) {
      await rootsExited(roots.map(({ fact }) => fact));
      count += await result.console.terminate(keys(roots));
    }
    return count;
  } finally {
    result.console.release();
  }
}
