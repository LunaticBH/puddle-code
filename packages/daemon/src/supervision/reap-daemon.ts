import { stopWindowsProcessTree, type WindowsProcessSource } from '@puddle/shared/node/platform';
import { clearPtyRoots, conptyRootBounds, readPtyRoots } from '../pty/pty-roots.js';
import type { SupervisedChild } from './windows-supervisor.js';

export interface ReapDaemonDeps {
  processes: WindowsProcessSource;
  /** The daemon's record of its live ConPTY roots (pty/pty-roots.ts). */
  rootsFile: string;
  /** Ends one process; TerminateProcess by default (stopWindowsProcessTree). */
  terminate?: (pid: number) => void;
}

/**
 * Stops what an exited Windows daemon left running, resolving with how many
 * processes that was: first the trees below the ConPTY roots it recorded,
 * whose pseudoconsoles ended those roots with the daemon, orphaning what
 * they started; then the daemon's own children, which name its pid and were
 * created while it ran. A root's pid may already belong to another process
 * by now: one created after the root could have been, or after the daemon
 * exited, is left alone with its children.
 */
export async function reapWindowsDaemon(
  daemon: Pick<SupervisedChild, 'pid' | 'startedAtMs'>,
  exitedAtMs: number,
  deps: ReapDaemonDeps,
): Promise<number> {
  let count = 0;
  // Another daemon's record (one that serves the home now) stays as it is.
  const roots = readPtyRoots(deps.rootsFile, daemon.pid);
  for (const root of roots ?? []) {
    const bounds = conptyRootBounds(root);
    const stopped = await stopWindowsProcessTree(root.pid, {
      processes: deps.processes,
      // A recorded root ran when the daemon did: a holder of its pid created
      // after the daemon exited is another process.
      root: { ...bounds, createdBeforeMs: Math.min(bounds.createdBeforeMs, exitedAtMs) },
      terminate: deps.terminate,
    });
    count += stopped.length;
  }
  if (roots !== null) clearPtyRoots(deps.rootsFile);
  const stopped = await stopWindowsProcessTree(daemon.pid, {
    processes: deps.processes,
    root: { startedAtMs: daemon.startedAtMs, exitedAtMs },
    terminate: deps.terminate,
  });
  return count + stopped.length;
}
