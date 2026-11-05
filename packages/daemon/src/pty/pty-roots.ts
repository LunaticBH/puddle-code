import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renameWithRetrySync } from '@puddle/shared/node/platform';

/**
 * The Windows daemon's live ConPTY roots, `<home>\pty-roots.json`, for the
 * resident supervisor (docs/windows.md, decision 6). When a daemon dies, its
 * pseudoconsoles end the processes attached to them at once, so by the time
 * the supervisor reads the process table those roots are gone and what they
 * started (a detached server, anything in a console of its own) names a
 * parent that no longer exists: only this record leads the supervisor to it.
 * Host-local state, never on the wire. This module must not load node-pty:
 * the supervisor's bundle imports it.
 */

export interface PtyRootRecord {
  pid: number;
  /** The clock just before `pty.spawn`. */
  startedAtMs: number;
  /** The clock just after `pty.spawn` returned. */
  spawnedAtMs: number;
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
 * node-pty creates the root inside `pty.spawn` (CreateProcessW runs before it
 * returns); a holder of its pid created more than this later, clock rounding
 * allowed for, is another process.
 */
const ROOT_START_MS = 1000;

/** What the process table may take for this PTY's root while it may still run. */
export function conptyRootBounds(root: Pick<PtyRootRecord, 'startedAtMs' | 'spawnedAtMs'>): {
  startedAtMs: number;
  createdBeforeMs: number;
} {
  return { startedAtMs: root.startedAtMs, createdBeforeMs: root.spawnedAtMs + ROOT_START_MS };
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

/** The roots `daemon` recorded; null when another process wrote the file, or nobody did. */
export function readPtyRoots(file: string, daemon: number): PtyRootRecord[] | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PtyRootsFile>;
    if (parsed.daemon !== daemon || !Array.isArray(parsed.roots)) return null;
    return parsed.roots.filter(
      (root): root is PtyRootRecord =>
        typeof root === 'object' &&
        root !== null &&
        Number.isSafeInteger(root.pid) &&
        root.pid > 0 &&
        Number.isFinite(root.startedAtMs) &&
        Number.isFinite(root.spawnedAtMs),
    );
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
