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
