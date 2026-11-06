import type { ChildProcess } from 'node:child_process';
import {
  imageSubsystem,
  isGuiSubsystem,
  listWindowsProcesses,
  windowsProcessTree,
  type WindowsProcess,
  type WindowsProcessSource,
  type WindowsSubsystemSource,
} from '@puddle/shared/node/platform';
import { sharedConptyJobs, type ConsoleInspector } from '../../pty/conpty-jobs.js';
import { endOwnConsole } from '../../pty/own-console.js';

/**
 * Ending a Codex app-server on Windows (docs/windows.md, decision 8). POSIX
 * sends SIGTERM to the process the daemon started, which the npm launcher
 * (`node codex.js`) passes on to the native server it runs; nothing else is
 * signalled. Windows has no SIGTERM, and TerminateProcess on the native
 * server leaves the commands it runs for the agent behind.
 *
 * The daemon starts the server hidden with no inherited stdio, so it has a
 * console of its own, which the native server and the commands it runs
 * inherit: that console stands for the server's session (pty/own-console.ts).
 * Ending the server ends the process the daemon started, by its own handle,
 * and what is attached to that console, each held open by the daemon's
 * ConPTY helper so that no pid it ends is another process's. Never a GUI
 * programme nor what one started, nor what left the console: a detached
 * process, one in a console of its own (`Start-Process`), or one on a
 * pseudoconsole of the server's (which ends as that console closes with the
 * server). Without the helper (Constrained Language Mode), npm's launcher,
 * node running codex.js, has the native server it started end first, by
 * pid, as the process table vouches for it while the launcher runs, then
 * the launcher, by its handle. Any other launcher (a native codex.exe, as
 * winget, scoop and the GitHub releases install it) is the server itself and
 * ends alone, by its handle: nothing then tells which of the commands it
 * runs are on its console.
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
  const root = { pid, startedAtMs: server.startedAtMs, createdBeforeMs: server.spawnedAtMs };
  const tree = windowsProcessTree(table, root);
  const launcher = tree[0]?.pid === pid ? tree[0] : undefined;
  if (!launcher) {
    // It has exited, and its pid may be another process's now.
    endLauncher();
    return;
  }
  const subsystem = deps.subsystem ?? imageSubsystem;
  const inspector = deps.inspector === undefined ? sharedConptyJobs() : deps.inspector;
  if (inspector) {
    const stop = await endOwnConsole(table, root, endLauncher, {
      processes,
      inspector,
      subsystem,
      now: deps.now ?? Date.now,
    }).catch(() => 'unavailable' as const);
    if (stop === 'ended') return;
  }
  // No console to go by. Only npm's launcher, node running codex.js, has a
  // direct child that is the native server, as this table vouches for it (a
  // console child of the launcher, created since, not its console's host):
  // the server goes first, by pid, while the launcher runs and holds the
  // server's handle (until it sees the server exit, as codex.js then exits
  // too): once the launcher has ended, and a node launcher's non-detached
  // child with it through libuv's kill-on-close job, another process may
  // hold that pid. A native launcher's children are the commands it runs.
  const servers: WindowsProcess[] = [];
  if (launcher.name.toLowerCase() === 'node.exe') {
    for (const entry of tree) {
      if (entry === launcher || entry.ppid !== pid) continue;
      if (entry.name.toLowerCase() === 'conhost.exe') continue;
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
