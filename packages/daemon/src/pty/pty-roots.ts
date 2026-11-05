import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renameWithRetrySync } from '@puddle/shared/node/platform';

/**
 * The Windows daemon's live ConPTYs, `<home>\pty-roots.json`, for the
 * resident supervisor (docs/windows.md, decision 6). When a daemon dies, its
 * pseudoconsoles close with it, and Windows ends the processes attached to
 * them; the record lets the supervisor end those that are still attached
 * once it runs, through each PTY's console host, or, for a PTY whose host
 * has gone, the console programmes below its root that still name it, and
 * for one whose host was never told apart, those attached to one of the
 * daemon's PTY consoles or to one that has gone, each root last, once it has
 * had the time Windows gives it to handle its console's close
 * (supervision/reap-daemon.ts). Host-local state, never on the wire. This
 * module must not load node-pty: the supervisor's bundle imports it.
 */

export interface PtyRootRecord {
  pid: number;
  /** The clock just before `pty.spawn`. */
  startedAtMs: number;
  /** The clock just after `pty.spawn` returned. */
  spawnedAtMs: number;
  /**
   * The root's creation time, as the ConPTY helper held it (conpty-jobs.ts):
   * with it the supervisor holds the root again, should it outlive the daemon.
   */
  createdAtMs?: number;
  /** When the root exited (node-pty's own callback), while its PTY was still being torn down. */
  exitedAtMs?: number;
  /** The PTY's headless console host, as the ConPTY helper told it apart (conpty-jobs.ts). */
  host?: { pid: number; createdAtMs: number };
}

interface PtyRootsFile {
  /** The daemon that wrote it. */
  daemon: number;
  roots: PtyRootRecord[];
}

export function ptyRootsFile(home: string): string {
  return join(home, 'pty-roots.json');
}

/**
 * What the process table may take for this PTY's root while it may still
 * run: node-pty creates the root inside `pty.spawn` (CreateProcessW runs
 * before it returns), so it was created between the clocks around it. The
 * table allows its own clock slack (about 100 ms) on top.
 */
export function conptyRootBounds(root: Pick<PtyRootRecord, 'startedAtMs' | 'spawnedAtMs'>): {
  startedAtMs: number;
  createdBeforeMs: number;
} {
  return { startedAtMs: root.startedAtMs, createdBeforeMs: root.spawnedAtMs };
}

/** Atomically replaces the record. Best effort: a full disk must not stop a PTY. */
export function writePtyRoots(file: string, daemon: number, roots: PtyRootRecord[]): void {
  const tmp = `${file}.${daemon}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ daemon, roots } satisfies PtyRootsFile) + '\n', {
      mode: 0o600,
    });
    renameWithRetrySync(tmp, file);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The next write replaces it.
    }
  }
}

const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** The roots `daemon` recorded; null when another process wrote the file, or nobody did. */
export function readPtyRoots(file: string, daemon: number): PtyRootRecord[] | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PtyRootsFile>;
    if (parsed.daemon !== daemon || !Array.isArray(parsed.roots)) return null;
    const roots: PtyRootRecord[] = [];
    for (const root of parsed.roots as unknown[]) {
      if (typeof root !== 'object' || root === null) continue;
      const { pid, startedAtMs, spawnedAtMs, createdAtMs, exitedAtMs, host } = root as Record<
        string,
        unknown
      >;
      if (!isId(pid) || !Number.isFinite(startedAtMs) || !Number.isFinite(spawnedAtMs)) continue;
      const record: PtyRootRecord = {
        pid,
        startedAtMs: startedAtMs as number,
        spawnedAtMs: spawnedAtMs as number,
      };
      if (isId(createdAtMs)) record.createdAtMs = createdAtMs;
      if (Number.isFinite(exitedAtMs)) record.exitedAtMs = exitedAtMs as number;
      const held = host as { pid?: unknown; createdAtMs?: unknown } | null | undefined;
      if (held && isId(held.pid) && isId(held.createdAtMs)) {
        record.host = { pid: held.pid, createdAtMs: held.createdAtMs };
      }
      roots.push(record);
    }
    return roots;
  } catch {
    return null;
  }
}

export function clearPtyRoots(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // The next daemon replaces it.
  }
}
