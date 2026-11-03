import { hostDirname, hostPathStyle, normaliseHostPath, type HostPathStyle } from '@puddle/shared';

/**
 * The UI's decisions about HOST paths that `@puddle/shared`'s path helpers
 * cannot make from a path alone (docs/windows.md, decision 11). Those helpers
 * infer the style from the path's own shape; this module adds the host's
 * reported platform, for the decisions taken with no absolute path in hand
 * (validating typed input, placeholders), and the identity rules for
 * comparing two absolute paths. POSIX hosts keep exactly their previous
 * behaviour: every Windows rule here is selected by a Windows-shaped path or a
 * `win32` platform. Pure and DOM-free.
 */

/** The host's path style from `GET /api/host`'s `platform`; absent (pre-25.7 daemons) means POSIX. */
export function hostStyleForPlatform(platform: string | undefined): HostPathStyle {
  return platform === 'win32' ? 'win32' : 'posix';
}

/** A drive path (`C:\`, `C:/`) or a UNC path (`\\server\share`). */
const WIN32_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * Whether typed text names a host directory the daemon can resolve: absolute,
 * or `~`-relative (expanded on the host). A Windows host also accepts drive
 * and UNC paths; `/` stays accepted there because Node reads it as the
 * current drive's root.
 */
export function isHostPathish(value: string, style: HostPathStyle): boolean {
  if (value.startsWith('/') || value.startsWith('~')) return true;
  return style === 'win32' && WIN32_ABSOLUTE.test(value);
}

/** `~` at the start of a typed path, followed by a separator the host accepts or by nothing. */
export function leadingTilde(style: HostPathStyle): RegExp {
  return style === 'win32' ? /^~(?=[\\/]|$)/ : /^~(?=\/|$)/;
}

/**
 * A root-relative path the user typed, in wire form: `/`-separated, with no
 * leading or trailing separator. A Windows host also takes `\`, so
 * `docs\notes.md` names the tree's own `docs/notes.md`; on POSIX a backslash
 * is an ordinary file-name character and is kept.
 */
export function typedRootRelativePath(input: string, style: HostPathStyle): string {
  const trimmed = input.trim();
  const slashed = style === 'win32' ? trimmed.replaceAll('\\', '/') : trimmed;
  return slashed.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Whether an absolute directory is the top of its tree: `/`, a drive root, or a UNC share. */
export function isHostRoot(dir: string): boolean {
  if (hostPathStyle(dir) === 'posix') return dir === '/';
  const normalised = normaliseHostPath(dir);
  return hostDirname(normalised) === normalised;
}

/**
 * A Windows path in the daemon's native form, with no trailing separator
 * below its root: `c:/Users/a/` → `C:\Users\a`, while `C:/` → `C:\`.
 */
export function nativeWindowsPath(path: string): string {
  const normalised = normaliseHostPath(path);
  return isHostRoot(normalised) ? normalised : normalised.replace(/\\+$/, '');
}

/**
 * The comparison key of an absolute host path. POSIX paths are their own key,
 * so equality stays exact there. Windows paths compare as Windows does: either
 * separator, any drive-letter or segment case, and no trailing separator below
 * the root (`C:/Users/A/` and `c:\users\a` share a key). Git prints
 * `C:/…` where Node prints `C:\…`, so a key built here matches both.
 */
export function hostPathKey(path: string): string {
  if (hostPathStyle(path) === 'posix') return path;
  return nativeWindowsPath(path).toLowerCase();
}

/** Whether two absolute host paths name the same directory or file (exact on POSIX). */
export function sameHostPath(a: string, b: string): boolean {
  return hostPathKey(a) === hostPathKey(b);
}
