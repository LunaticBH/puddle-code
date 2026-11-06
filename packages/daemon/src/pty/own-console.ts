import {
  imageSubsystem,
  isGuiSubsystem,
  listWindowsProcesses,
  windowsDescendantsOf,
  windowsProcessTree,
  type ProcessTreeRoot,
  type WindowsProcess,
  type WindowsProcessSource,
  type WindowsSubsystemSource,
} from '@puddle/shared/node/platform';
import { sharedConptyJobs, type ClassifiedProcess, type ConsoleInspector } from './conpty-jobs.js';

/**
 * Ending a child of the daemon that has a console of its own, and what is
 * attached to that console (docs/windows.md, decision 8): the Codex
 * app-server, compile commands and notebook bridges. The daemon starts each
 * hidden with no inherited stdio, so libuv gives it CREATE_NO_WINDOW: a new,
 * windowless console, whose host is the conhost.exe the child creates as it
 * starts, and which the console programmes it runs inherit. No other process
 * of the daemon's is on it: every PTY has its pseudoconsole, every other such
 * child a console of its own, and neither the daemon (its supervisor's
 * console) nor its helpers (none) share one with a child. So that console
 * stands for the child's POSIX process group, as the headless driver's CLI
 * console does (agents/headless/terminal-source.ts).
 *
 * Ending it ends the child, through its own handle, and every process that
 * the ConPTY helper (`classify`, conpty-jobs.ts) finds attached to the
 * console's host, which it holds meanwhile: a process naming that host that
 * was created after it is on that console, as no other process can hold the
 * host's pid while it is held. That reaches what the child's descendants left
 * on the console as they exited (`cmd /c start /b`), which nothing in the
 * process table leads to, and spares what left it, as POSIX `setsid` does: a
 * detached process (no console) or one in a console of its own
 * (`Start-Process`, `start`). Never a GUI programme, nor what one started;
 * every pid it ends is one the helper holds. Without the helper, or without a
 * console host to go by (a GUI child has none), it ends nothing and says so:
 * the caller falls back on the process table's tree.
 */

export interface OwnConsoleDeps {
  /** The process table; the shared worker's by default. */
  processes?: WindowsProcessSource;
  /** The ConPTY helper that holds what it ends; the daemon's by default, null for none. */
  inspector?: Pick<ConsoleInspector, 'classify'> | null;
  /** Each process's PE subsystem; read from its image by default. */
  subsystem?: WindowsSubsystemSource;
  /** This process's clock; `Date.now` by default. */
  now?: () => number;
}

const identity = (entry: { pid: number; createdAtMs: number | null }) =>
  `${entry.pid}@${entry.createdAtMs}`;

/**
 * Ends `root` (through `endRoot`, its own handle) and what is attached to its
 * console, reading the process table first. True once that is done; false,
 * with nothing ended, without a helper, a table, or a console host the helper
 * holds: the caller falls back. Never rejects.
 */
export async function stopOwnConsole(
  root: ProcessTreeRoot,
  endRoot: () => void,
  deps: OwnConsoleDeps = {},
): Promise<boolean> {
  const inspector = deps.inspector === undefined ? sharedConptyJobs() : deps.inspector;
  if (!inspector) return false;
  const processes = deps.processes ?? listWindowsProcesses;
  try {
    const table = await processes({ fresh: true });
    return await endOwnConsole(table, root, endRoot, {
      processes,
      inspector,
      subsystem: deps.subsystem ?? imageSubsystem,
      now: deps.now ?? Date.now,
    });
  } catch {
    return false;
  }
}

/**
 * The console host `root` created as it started, from `tree` (its tree in
 * one table): its earliest conhost.exe child that is not a pseudoconsole's
 * (`--headless`, which a child running a PTY of its own creates). Undefined
 * when it has none, as a GUI programme has not.
 */
export function ownConsoleHost(
  tree: readonly WindowsProcess[],
  rootPid: number,
): WindowsProcess | undefined {
  return tree
    .filter(
      (entry) =>
        entry.ppid === rootPid &&
        entry.pid !== rootPid &&
        entry.name.toLowerCase() === 'conhost.exe' &&
        entry.createdAtMs !== null &&
        entry.commandLine !== null &&
        !/--headless/i.test(entry.commandLine),
    )
    .sort((a, b) => a.createdAtMs! - b.createdAtMs!)[0];
}

/**
 * `stopOwnConsole` on a table already read for it. A root that has exited
 * counts only when its exit time is known: its children are then those it
 * created while it ran, its console's host among them. Rejects when the
 * table cannot be read again, having ended what it could.
 */
export async function endOwnConsole(
  table: readonly WindowsProcess[],
  root: ProcessTreeRoot,
  endRoot: () => void,
  deps: Required<OwnConsoleDeps> & { inspector: Pick<ConsoleInspector, 'classify'> },
): Promise<boolean> {
  const tree = windowsProcessTree(table, root);
  const running = tree[0]?.pid === root.pid ? tree[0] : undefined;
  if (!running && root.exitedAtMs === undefined) return false;
  const host = ownConsoleHost(tree, root.pid);
  if (!host) return false;
  return endConsole(table, tree, running, host, endRoot, deps);
}

/**
 * What may be attached to the console `host` holds, from one table: the
 * root's tree, and every orphan created since the host (a process whose
 * parent has exited, as `cmd /c start /b` leaves one), each with what is
 * below it. The root itself is ended by its handle.
 */
function candidates(
  table: readonly WindowsProcess[],
  tree: readonly WindowsProcess[],
  root: WindowsProcess | undefined,
  host: WindowsProcess,
): WindowsProcess[] {
  const since = host.createdAtMs!;
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const orphans = table.filter((entry) => {
    if (entry.createdAtMs === null || entry.createdAtMs < since) return false;
    const parent = byPid.get(entry.ppid);
    return (
      parent === undefined || parent.createdAtMs === null || parent.createdAtMs > entry.createdAtMs
    );
  });
  const seen = new Set([identity(host), ...(root ? [identity(root)] : [])]);
  return [...tree, ...orphans, ...windowsDescendantsOf(table, orphans)].filter((entry) => {
    if (entry.pid === process.pid || seen.has(identity(entry))) return false;
    seen.add(identity(entry));
    return true;
  });
}

/**
 * Ends the root, then what is attached to its console, at most three
 * rounds (the table read again for children started meanwhile). False,
 * with nothing ended, when the helper did not answer, no longer holds the
 * console's host, or holds a running root attached to another console.
 */
async function endConsole(
  table: readonly WindowsProcess[],
  tree: readonly WindowsProcess[],
  root: WindowsProcess | undefined,
  host: WindowsProcess,
  endRoot: () => void,
  deps: Required<OwnConsoleDeps> & { inspector: Pick<ConsoleInspector, 'classify'> },
): Promise<boolean> {
  let entries = candidates(table, tree, root, host);
  let byPid = new Map(table.map((entry) => [entry.pid, entry]));
  let heldHost: ClassifiedProcess | undefined;
  /** What has been ended, and when: its children are not created after. */
  const ended = new Map<string, { entry: WindowsProcess; atMs: number }>();
  /** What a round has looked at: what it spared stays spared. */
  const considered = new Set([identity(host), ...(root ? [identity(root)] : [])]);
  for (let round = 0; round < 3; round++) {
    for (const entry of entries) considered.add(identity(entry));
    const asked = round === 0 ? [host, ...(root ? [root] : []), ...entries] : entries;
    const held = await deps.inspector.classify(known(asked));
    if (!held) return round > 0;
    try {
      if (round === 0) {
        heldHost = held.processes.find((entry) => entry.pid === host.pid);
        // The host has exited: what names its pid tells nothing.
        if (!heldHost) return false;
        // A running root attached to another console: this host is not its own.
        const own = root && held.processes.find((entry) => entry.pid === root.pid);
        if (own && own.consoleHost > 0 && own.consoleHost !== heldHost.pid) return false;
        if (root) {
          ended.set(identity(root), { entry: root, atMs: deps.now() });
          endRoot();
        }
      }
      const console = heldHost!;
      const classified = new Map(held.processes.map((entry) => [entry.pid, entry]));
      const targets: string[] = [];
      for (const entry of entries) {
        const member = classified.get(entry.pid);
        if (!member || member.key === console.key || member.gui) continue;
        if (member.consoleHost !== console.pid || member.createdAtMs < console.createdAtMs)
          continue;
        if (await startedByGui(entry, root, byPid, classified, deps.subsystem)) continue;
        targets.push(member.key);
        ended.set(identity(entry), { entry, atMs: deps.now() });
      }
      if (targets.length === 0) break;
      await held.console.terminate(targets);
    } finally {
      held.console.release();
    }
    if (round === 2) break;
    let later: readonly WindowsProcess[];
    try {
      later = await deps.processes({ fresh: true });
    } catch {
      break;
    }
    byPid = new Map(later.map((entry) => [entry.pid, entry]));
    entries = windowsDescendantsOf(
      later,
      [...ended.values()].map((each) => each.entry),
      (parent) => ended.get(identity(parent))?.atMs,
    ).filter((entry) => !considered.has(identity(entry)));
    if (entries.length === 0) break;
  }
  return true;
}

/** Entries the helper can hold: those with a creation time. */
function known(entries: readonly WindowsProcess[]): { pid: number; createdAtMs: number }[] {
  return entries.flatMap((entry) =>
    entry.createdAtMs === null ? [] : [{ pid: entry.pid, createdAtMs: entry.createdAtMs }],
  );
}

/**
 * Whether a GUI programme started `entry`, or one of its ancestors below
 * the root (whose own image never counts): what a GUI programme starts is
 * never ended. An ancestor that has exited, or whose pid another process
 * holds now, ends the search: Windows keeps nothing of it.
 */
async function startedByGui(
  entry: WindowsProcess,
  root: WindowsProcess | undefined,
  byPid: ReadonlyMap<number, WindowsProcess>,
  classified: ReadonlyMap<number, ClassifiedProcess>,
  subsystem: WindowsSubsystemSource,
): Promise<boolean> {
  let current = entry;
  for (let depth = 0; depth < 64; depth++) {
    const parent = byPid.get(current.ppid);
    if (
      parent === undefined ||
      parent.createdAtMs === null ||
      current.createdAtMs === null ||
      parent.createdAtMs > current.createdAtMs ||
      parent.pid === current.pid
    ) {
      return false;
    }
    if (root && identity(parent) === identity(root)) return false;
    const held = classified.get(parent.pid);
    const gui =
      held !== undefined && Math.abs(held.createdAtMs - parent.createdAtMs) <= 1
        ? held.gui
        : isGuiSubsystem(await subsystem(parent).catch(() => null));
    if (gui) return true;
    current = parent;
  }
  return false;
}
