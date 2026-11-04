import { realpath } from 'node:fs/promises';
import { win32 } from 'node:path';
import { isInsideHostPath } from '@puddle/shared';

/**
 * Windows-only path decisions for the worktree routes (docs/windows.md,
 * decision 11). Each takes an injectable `platform`, so both branches are
 * tested on every host; POSIX answers are exactly what the routes gave before.
 */

/**
 * Whether `/resolve` must refuse `abs` before touching the filesystem: on
 * Windows, a UNC (`\\server\share`) or device (`\\?\`, `\\.\`) path outside
 * every one of `roots`. The candidate comes from terminal output, which any
 * program can write, and merely opening a UNC path makes Windows connect to
 * that server and offer the user's credentials; a server that never answers
 * also holds the call for the SMB timeout. A worktree that itself lives on a
 * share keeps resolving its own files. Never true on POSIX, where `\\` is not
 * a network prefix.
 */
export function refusesForeignNetworkPath(
  abs: string,
  roots: () => readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32' || !/^[\\/]{2}/.test(abs)) return false;
  return !roots().some((root) => isInsideHostPath(root, abs));
}

/**
 * The path of `abs` below `base` as Windows stores it on disk (`src\App.tsx`
 * for a request spelt `SRC/app.tsx`), or null to keep the caller's own
 * spelling. Windows finds a file whatever case it is asked for, so without
 * this one file would answer to several spellings and the UI would open a tab
 * and a buffer for each. The real path supplies the case only when following
 * links leaves the path where it was: a file reached through a symlink or
 * junction keeps reading as inside the tree that links to it. Always null on
 * POSIX.
 */
export async function onDiskRelative(
  base: string,
  abs: string,
  platform: NodeJS.Platform = process.platform,
  real: (path: string) => Promise<string> = realpath,
): Promise<string | null> {
  if (platform !== 'win32') return null;
  try {
    const [realBase, realAbs] = await Promise.all([real(base), real(abs)]);
    const onDisk = win32.relative(realBase, realAbs);
    return onDisk.toLowerCase() === win32.relative(base, abs).toLowerCase() ? onDisk : null;
  } catch {
    return null; // unreadable or gone: the caller's spelling still names it
  }
}
