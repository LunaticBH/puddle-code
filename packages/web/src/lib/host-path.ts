import {
  hostDirname,
  hostPathStyle,
  normaliseHostPath,
  windowsNameProblem,
  type HostPathStyle,
} from '@puddle/shared';

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

/**
 * Why a name typed for a new or renamed entry cannot be stored on the host,
 * or null. Only a Windows host refuses names (reserved device names,
 * `<>:"|?*`, a trailing dot or space: `windowsNameProblem`), and it checks
 * every segment of a typed `a\b` or `a/b`, as the daemon does before it
 * answers 400 `invalid_name`. A POSIX host accepts every name, as before.
 */
export function hostNameProblem(name: string, style: HostPathStyle): string | null {
  if (style !== 'win32') return null;
  for (const segment of name.split(/[\\/]/)) {
    const problem = segment === '' ? null : windowsNameProblem(segment);
    if (problem !== null) return problem;
  }
  return null;
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

/** A file as tab and buffer keys identify it: `path`, relative to an external tab's `root`. */
export interface FileIdentity {
  path: string;
  root?: string;
}

/**
 * The spelling tab and buffer keys compare a file by. Under a Windows root a
 * name compares as Windows compares it, in any case and with either
 * separator, so one file reached by two spellings opens one tab and one
 * buffer. Every other identity is exact, POSIX roots included. A worktree
 * file carries no root and keeps the daemon's spelling, which a Windows host
 * gives in the case the file is stored in.
 */
export function fileIdentity(path: string, root?: string): FileIdentity {
  if (root === undefined || hostPathStyle(root) !== 'win32') {
    return root === undefined ? { path } : { path, root };
  }
  return { path: path.replaceAll('\\', '/').toLowerCase(), root: hostPathKey(root) };
}

/** Whether two tabs or buffers name one file, comparing `fileIdentity` exactly. */
export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  const left = fileIdentity(a.path, a.root);
  const right = fileIdentity(b.path, b.root);
  return left.path === right.path && left.root === right.root;
}
