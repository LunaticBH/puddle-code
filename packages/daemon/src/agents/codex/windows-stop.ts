import type { ChildProcess } from 'node:child_process';
import {
  imageSubsystem,
  isGuiSubsystem,
  listWindowsProcesses,
  windowsDescendantsOf,
  windowsProcessTree,
  type WindowsProcess,
  type WindowsProcessSource,
  type WindowsSubsystemSource,
} from '@puddle/shared/node/platform';
import {
  sharedConptyJobs,
  type ClassifiedProcess,
  type ConsoleInspector,
} from '../../pty/conpty-jobs.js';

/**
 * Ending a Codex app-server on Windows (docs/windows.md, decision 8). POSIX
 * sends SIGTERM to the process the daemon started, which the npm launcher
 * (`node codex.js`) passes on to the native server it runs; nothing else is
 * signalled. Windows has no SIGTERM, and TerminateProcess on the native
 * server leaves the commands it runs for the agent behind.
 *
 * The daemon starts the server hidden with no inherited stdio, so libuv
 * gives it CREATE_NO_WINDOW and a console of its own, which the native
 * server and the commands it runs inherit: that console stands for the
 * server's session, as the headless driver's CLI console does
 * (agents/headless/terminal-source.ts). Ending the server ends the process
 * the daemon started, by its own handle, and what is attached to that
 * console, each held open by the daemon's ConPTY helper (`classify`,
 * pty/conpty-jobs.ts) so that no pid it ends is another process's. Never a
 * GUI programme nor what one started, nor what left the console: a
 * detached process, one in a console of its own (`Start-Process`), or one
 * on a pseudoconsole of the server's (which ends as that console closes
 * with the server). Without the helper (Constrained Language Mode), npm's
 * launcher (node running codex.js) has the native server it started end
 * first, as the process table vouches for it while the launcher runs, then
 * the launcher, by its handle. Any other launcher (a native codex.exe, as
 * winget, scoop and the GitHub releases install it) is the server itself
 * and ends alone, by its handle.
 */

/** The app-server process the daemon started, and when (this process's clock). */
export interface CodexServerProcess {
  readonly child: ChildProcess;
  /** Just before `spawn`. */
  readonly startedAtMs: number;
  /** Just after `spawn` returned. */
  readonly spawnedAtMs: number;
}

export interface CodexStopDeps {
  /** The process table; the shared worker's by default. */
  processes?: WindowsProcessSource;
  /** The ConPTY helper that holds what it ends; the daemon's by default, null for none. */
  inspector?: Pick<ConsoleInspector, 'classify'> | null;
  /** Each process's PE subsystem; read from its image by default. */
  subsystem?: WindowsSubsystemSource;
  /** This process's clock; `Date.now` by default. */
  now?: () => number;
  /** Ends one process by pid, without the helper; TerminateProcess through `process.kill` by default. */
  terminate?: (pid: number) => void;
}

const identity = (entry: { pid: number; createdAtMs: number | null }) =>
  `${entry.pid}@${entry.createdAtMs}`;

/** Ends `server` and what is attached to its console; never rejects. */
export async function stopCodexServerWindows(
  server: CodexServerProcess,
  deps: CodexStopDeps = {},
): Promise<void> {
  const { child } = server;
  const pid = child.pid;
  if (pid === undefined) return;
  const endLauncher = () => {
    try {
      child.kill();
    } catch {
      // Exited meanwhile.
    }
  };
  const processes = deps.processes ?? listWindowsProcesses;
  let table: readonly WindowsProcess[];
  try {
    table = await processes({ fresh: true });
  } catch {
    endLauncher();
    return;
  }
  const tree = windowsProcessTree(table, {
    pid,
    startedAtMs: server.startedAtMs,
    createdBeforeMs: server.spawnedAtMs,
  });
  const launcher = tree[0]?.pid === pid ? tree[0] : undefined;
  if (!launcher) {
    // It has exited, and its pid may be another process's now.
    endLauncher();
    return;
  }
  // Its own console's host: the conhost.exe it created as it started.
  const host = tree.find(
    (entry) =>
      entry.ppid === pid && entry !== launcher && entry.name.toLowerCase() === 'conhost.exe',
  );
  const inspector = deps.inspector === undefined ? sharedConptyJobs() : deps.inspector;
  if (host && inspector) {
    const ended = await endConsole(table, tree, launcher, host, inspector, endLauncher, {
      processes,
      subsystem: deps.subsystem ?? imageSubsystem,
      now: deps.now ?? Date.now,
    }).catch(() => false);
    if (ended) return;
  }
  // No console to go by. Only npm's launcher, node running codex.js, has a
  // direct child that is the native server, as this table vouches for it (a
  // console child of the launcher, created since, not its console's host):
  // the server goes first, by pid, while the launcher runs and holds the
  // server's handle (until it sees the server exit, as codex.js then exits
  // too): once the launcher has ended, and a node launcher's non-detached
  // child with it through libuv's kill-on-close job, another process may
  // hold that pid. A native launcher (codex.exe) is the server itself: its
  // children are the commands it runs, which nothing here tells on its
  // console from what left it, so it ends alone, by its handle.
  const subsystem = deps.subsystem ?? imageSubsystem;
  const servers: WindowsProcess[] = [];
  if (launcher.name.toLowerCase() === 'node.exe') {
    for (const entry of tree) {
      if (entry === launcher || entry.ppid !== pid) continue;
      if (entry === host || entry.name.toLowerCase() === 'conhost.exe') continue;
      const kind = await subsystem(entry).catch(() => null);
      if (kind !== null && !isGuiSubsystem(kind)) servers.push(entry);
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    const terminate =
      deps.terminate ??
      ((target: number) => {
        process.kill(target);
      });
    for (const entry of servers) {
      try {
        terminate(entry.pid);
      } catch {
        // Exited meanwhile.
      }
    }
  }
  endLauncher();
}

/**
 * What may be attached to the console `host` holds, from one table: the
 * launcher's tree, and every orphan created since the host (a process
 * whose parent has exited, as `cmd /c start /b` leaves one), each with what
 * is below it. The launcher itself is ended by its handle.
 */
function candidates(
  table: readonly WindowsProcess[],
  tree: readonly WindowsProcess[],
  launcher: WindowsProcess,
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
  const seen = new Set([identity(launcher), identity(host)]);
  return [...tree, ...orphans, ...windowsDescendantsOf(table, orphans)].filter((entry) => {
    if (entry.pid === process.pid || seen.has(identity(entry))) return false;
    seen.add(identity(entry));
    return true;
  });
}

/**
 * Ends the launcher, then what is attached to its console, at most three
 * rounds (the table read again for children started meanwhile). False,
 * with nothing ended, when the helper did not answer or no longer holds the
 * console's host.
 */
async function endConsole(
  table: readonly WindowsProcess[],
  tree: readonly WindowsProcess[],
  launcher: WindowsProcess,
  host: WindowsProcess,
  inspector: Pick<ConsoleInspector, 'classify'>,
  endLauncher: () => void,
  deps: Required<Pick<CodexStopDeps, 'processes' | 'subsystem' | 'now'>>,
): Promise<boolean> {
  let entries = candidates(table, tree, launcher, host);
  let byPid = new Map(table.map((entry) => [entry.pid, entry]));
  let heldHost: ClassifiedProcess | undefined;
  /** What has been ended, and when: its children are not created after. */
  const ended = new Map<string, { entry: WindowsProcess; atMs: number }>();
  /** What a round has looked at: what it spared stays spared. */
  const considered = new Set([identity(launcher), identity(host)]);
  for (let round = 0; round < 3; round++) {
    for (const entry of entries) considered.add(identity(entry));
    const held = await inspector.classify(known(round === 0 ? [host, ...entries] : entries));
    if (!held) return round > 0;
    try {
      if (round === 0) {
        heldHost = held.processes.find((entry) => entry.pid === host.pid);
        // The host has exited: what names its pid tells nothing.
        if (!heldHost) return false;
        ended.set(identity(launcher), { entry: launcher, atMs: deps.now() });
        endLauncher();
      }
      const console = heldHost!;
      const classified = new Map(held.processes.map((entry) => [entry.pid, entry]));
      const targets: string[] = [];
      for (const entry of entries) {
        const member = classified.get(entry.pid);
        if (!member || member.key === console.key || member.gui) continue;
        if (member.consoleHost !== console.pid || member.createdAtMs < console.createdAtMs)
          continue;
        if (await startedByGui(entry, launcher, byPid, classified, deps.subsystem)) continue;
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
 * the launcher (whose own image never counts): what a GUI programme starts
 * is never ended. An ancestor that has exited, or whose pid another process
 * holds now, ends the search: Windows keeps nothing of it.
 */
async function startedByGui(
  entry: WindowsProcess,
  launcher: WindowsProcess,
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
    if (identity(parent) === identity(launcher)) return false;
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
