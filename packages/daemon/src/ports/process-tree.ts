import { execFile } from 'node:child_process';
import { listWindowsProcesses, type WindowsProcess } from '@puddle/shared/node/platform';
import { bornAfter } from '../pty/foreground-process.js';

/**
 * Parses `ps -axo pid=,ppid=` output (identical flags/columns on macOS and
 * Linux — one code path) into a ppid → children map. Malformed lines are
 * skipped rather than throwing: a stray header or truncated line shouldn't
 * take down port detection.
 */
export function parsePsOutput(stdout: string): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\d+)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }
  return children;
}

export interface DescendantsOptions {
  platform?: NodeJS.Platform;
  /** The Windows process table; the shared worker by default. */
  windowsProcesses?: () => Promise<readonly WindowsProcess[]>;
}

/**
 * Every pid reachable from `roots` (inclusive) by following child links, via
 * a single host-wide `ps` snapshot and a BFS. Empty roots short-circuits
 * without exec'ing anything — exited/interrupted sessions cost nothing.
 *
 * Pid reuse between the `ps` snapshot and the caller's use of the result is
 * an accepted race (SPEC §9): the window is milliseconds and the worst case
 * is a stale/missing port entry, not a security issue.
 *
 * Windows has no `ps` (Git Bash's MSYS one reports MSYS pids), so the shared
 * Win32_Process table is read instead (docs/windows.md, decision 8). There a
 * dead parent's pid is never re-parented and is soon reused, so a child is
 * followed only when it is not older than its parent: otherwise an
 * unrelated process could adopt a recycled PTY pid's orphans, and their
 * ports would become proxyable through the session.
 */
export function descendantsOf(
  roots: number[],
  opts: DescendantsOptions = {},
): Promise<Set<number>> {
  if (roots.length === 0) return Promise.resolve(new Set());
  if ((opts.platform ?? process.platform) === 'win32') {
    return (opts.windowsProcesses ?? listWindowsProcesses)().then((table) =>
      windowsDescendants(roots, table),
    );
  }
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'pid=,ppid='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      const childrenOf = parsePsOutput(stdout);
      const seen = new Set<number>(roots);
      const queue = [...roots];
      while (queue.length > 0) {
        const pid = queue.shift()!;
        for (const child of childrenOf.get(pid) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          queue.push(child);
        }
      }
      resolve(seen);
    });
  });
}

/**
 * The BFS above over a Windows process table, creation-time checked. A root
 * missing from the table (a sidecar that has exited, or a PTY spawned after
 * the table was read) has no creation time to check against, and any process
 * still naming its pid as parent may be an earlier holder's orphan, so its
 * children are not followed.
 */
export function windowsDescendants(
  roots: readonly number[],
  table: readonly WindowsProcess[],
): Set<number> {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const childrenOf = new Map<number, WindowsProcess[]>();
  for (const entry of table) {
    // pid 0 (System Idle) lists itself as its own parent.
    if (entry.pid === entry.ppid) continue;
    const siblings = childrenOf.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else childrenOf.set(entry.ppid, [entry]);
  }
  const seen = new Set<number>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    const parent = byPid.get(pid);
    if (!parent) continue;
    for (const child of childrenOf.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      if (!bornAfter(child, parent)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
    }
  }
  return seen;
}
