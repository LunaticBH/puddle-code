import { renameSync } from 'node:fs';
import { renameWithRetrySync } from '@puddle/shared/node/platform';
import { ApiError } from '../http/errors.js';

/** How Windows reports a directory that another process holds a handle inside. */
const IN_USE = new Set(['EPERM', 'EBUSY', 'EACCES']);

export function worktreeBusy(path: string): ApiError {
  return ApiError.conflict(
    'worktree_busy',
    `files in ${path} are open in another program (a terminal, agent, editor or dev server) — ` +
      'close them and try again',
  );
}

/**
 * Throws 409 `worktree_busy` while any process holds a handle inside `dir`.
 *
 * Windows cannot delete a directory that something has open: a terminal or
 * agent whose working directory is inside it, an open file, a watcher. `git
 * worktree remove` would then fail part-way, after deleting its own admin
 * directory, and leave a half-deleted orphan behind. Renaming a directory
 * fails for exactly those handles, so a rename to a sibling and straight back
 * proves the tree can go before anything is deleted (verified on Windows 11:
 * an open file, an `fs.watch` and a child's cwd each make it fail with EPERM).
 */
export function assertNotHeldOpen(dir: string): void {
  const probe = `${dir}.puddle-removal-${process.pid}`;
  try {
    renameSync(dir, probe);
  } catch (error) {
    if (IN_USE.has((error as NodeJS.ErrnoException).code ?? '')) throw worktreeBusy(dir);
    throw error;
  }
  // Nothing knows the probe name, but a scanner may glance at it: retry briefly.
  renameWithRetrySync(probe, dir, 'win32');
}
