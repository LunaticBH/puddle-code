import { realpathSync } from 'node:fs';
import { isInsideHostPath, normaliseHostPath } from '@puddle/shared';

/**
 * The one spelling of an absolute host path that the daemon stores, compares
 * and emits (docs/windows.md decision 11). Windows resolves the native
 * real path and upper-cases the drive letter, so `c:/Users/a` and
 * `C:\users\a` become one identity; a path that does not exist yet is only
 * normalised. POSIX paths are returned untouched: callers there keep their
 * existing realpath semantics.
 */
export function canonicalHostPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return path;
  let resolved = path;
  try {
    resolved = realpathSync.native(path);
  } catch {
    // Not created yet (or unreadable): the normalised spelling is still stable.
  }
  return normaliseHostPath(resolved);
}

/** Path identity: exact on POSIX, separator- and case-insensitive on Windows. */
export function sameHostPath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return a === b;
  return isInsideHostPath(a, b) && isInsideHostPath(b, a);
}
