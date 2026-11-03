import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import {
  hostPathStyle,
  isAbsoluteHostPath,
  isInsideHostPath,
  normaliseHostPath,
} from '@puddle/shared';

/**
 * The one spelling of an absolute host path that the daemon stores, compares
 * and emits (docs/windows.md decision 11). Windows resolves the native
 * real path and upper-cases the drive letter, so `c:/Users/a` and
 * `C:\users\a` become one identity; a path that does not exist yet keeps the
 * canonical spelling of its deepest existing ancestor and is otherwise only
 * normalised. POSIX paths are returned untouched: callers there keep their
 * existing realpath semantics.
 */
export function canonicalHostPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return path;
  if (hostPathStyle(path) === 'win32') {
    return normaliseHostPath(realAncestry(win32.normalize(path)));
  }
  let resolved = path;
  try {
    resolved = realpathSync.native(path);
  } catch {
    // Not created yet (or unreadable): the normalised spelling is still stable.
  }
  return normaliseHostPath(resolved);
}

/** `realpath.native`, falling back to the real parent plus the missing name. */
function realAncestry(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = win32.dirname(path);
    if (parent === path) return path;
    return win32.join(realAncestry(parent), win32.basename(path));
  }
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

/** The `node:path` flavour that describes this host's own paths. */
export function hostPathApi(platform: NodeJS.Platform = process.platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/**
 * A root-relative path as it travels on the wire: always `/`-separated, on
 * every host (decision 11). `path.relative` speaks `\` on Windows; POSIX
 * results are returned untouched.
 */
export function wireRelative(rel: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? rel.replaceAll('\\', '/') : rel;
}

/**
 * Whether a client-supplied path names an absolute location on this host. On
 * Windows only drive (`C:\x`, `C:/x`) and UNC paths qualify: `\x` and `/x`
 * are relative to the daemon's current drive, and a bare `C:` to that drive's
 * per-process directory. POSIX keeps `path.isAbsolute`.
 */
export function isNativeAbsolute(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return posix.isAbsolute(path);
  return hostPathStyle(path) === 'win32' && isAbsoluteHostPath(path);
}

/** A bare Windows drive (`C:`) means that drive's root; everything else is returned as given. */
export function rootBareDrive(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && /^[A-Za-z]:$/.test(path) ? `${path}\\` : path;
}
