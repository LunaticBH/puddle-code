/**
 * Path arithmetic for HOST paths: absolute paths on the daemon's machine,
 * whose style may differ from the OS this code runs on (a browser or a
 * macOS cockpit talking to a Windows daemon, or the reverse). The style is
 * inferred from the path itself, never from the local OS, so POSIX paths keep
 * exactly the results `path.posix` gives (docs/windows.md, decision 11).
 *
 * Pure and browser-safe: no Node imports. Root-relative paths on the wire
 * always use `/`; absolute Windows paths use `\`.
 */

export type HostPathStyle = 'win32' | 'posix';

/** A drive root (`C:\`, `C:/` or a bare `C:`), a UNC share (`\\server`) or a `\\?\` device path. */
const WIN32_PATH = /^(?:[A-Za-z]:(?:[\\/]|$)|\\\\)/;

/** Windows style for drive, UNC and device paths; POSIX for everything else. */
export function hostPathStyle(path: string): HostPathStyle {
  return WIN32_PATH.test(path) ? 'win32' : 'posix';
}

export function hostSeparator(style: HostPathStyle): '\\' | '/' {
  return style === 'win32' ? '\\' : '/';
}

export function isAbsoluteHostPath(path: string): boolean {
  if (hostPathStyle(path) === 'posix') return path.startsWith('/');
  // Everything but a bare drive (`C:`, relative to that drive's current directory).
  return splitWin32(path).root.endsWith('\\');
}

/** `path.posix.normalize` for POSIX paths; Windows paths gain `\` separators and an upper-case drive letter. */
export function normaliseHostPath(path: string): string {
  if (hostPathStyle(path) === 'posix') return posixNormalise(path);
  const normalised = win32Normalise(path);
  return /^[a-z]:/.test(normalised)
    ? normalised[0]!.toUpperCase() + normalised.slice(1)
    : normalised;
}

/**
 * `path.posix.dirname` for POSIX paths. Windows paths follow
 * `path.win32.dirname`, except that the result always uses `\` and never
 * ends in a separator below its root.
 */
export function hostDirname(path: string): string {
  if (hostPathStyle(path) === 'posix') return posixDirname(path);
  const { root, rest } = splitWin32(path);
  const trimmed = rest.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (cut === -1) return root;
  return (
    root +
    trimmed
      .slice(0, cut)
      .replace(/[\\/]+$/, '')
      .replaceAll('/', '\\')
  );
}

/** `path.posix.basename` for POSIX paths; `path.win32.basename` for Windows paths. */
export function hostBasename(path: string): string {
  if (hostPathStyle(path) === 'posix') return posixBasename(path);
  // Like path.win32, only a drive is set aside: a share's basename is its name.
  const trimmed = path.replace(/^[A-Za-z]:/, '').replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/')) + 1);
}

/**
 * Join a root-relative path (`/`-separated; `\` is also accepted on Windows
 * hosts) onto an absolute host directory, in the base's own style.
 * `path.posix.join` for POSIX bases.
 */
export function hostJoin(base: string, relative: string): string {
  if (hostPathStyle(base) === 'posix') return posixJoin(base, relative);
  return normaliseHostPath(relative === '' ? base : `${base}\\${relative}`);
}

/**
 * Whether absolute `candidate` is `root` itself or lies beneath it, on
 * segment boundaries (`/repo-copy` is not inside `/repo`). Windows paths
 * compare case-insensitively and accept either separator. Relative inputs,
 * and paths of different styles, are never inside.
 */
export function isInsideHostPath(root: string, candidate: string): boolean {
  return relativeSegments(root, candidate) !== null;
}

/**
 * The `/`-separated path of absolute `absolute` relative to `root` (`''` for
 * the root itself), or null when it is not inside the root. Segments keep the
 * candidate's own spelling. Equals `path.posix.relative` for POSIX paths
 * inside the root.
 */
export function toRootRelative(root: string, absolute: string): string | null {
  return relativeSegments(root, absolute)?.join('/') ?? null;
}

/** Device names Windows reserves in every directory, with or without an extension. */
const WIN32_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;
// eslint-disable-next-line no-control-regex -- control characters are exactly what Windows refuses.
const WIN32_FORBIDDEN_CHARACTER = /[<>:"|?*\u0000-\u001f]/;

/**
 * Why Windows cannot store `name` as one file or directory name, or null when
 * it can: reserved device names (`CON`, `nul.txt`, `COM1`), the characters
 * `<>:"|?*` and control characters (a `:` would also address an alternate
 * data stream), and a trailing dot or space, which Windows strips. Node's
 * `\\?\` paths would create such names anyway, leaving entries that Explorer,
 * cmd and Git cannot handle. `.` and `..` are navigation, not names.
 */
export function windowsNameProblem(name: string): string | null {
  if (name === '.' || name === '..') return null;
  if (WIN32_FORBIDDEN_CHARACTER.test(name)) {
    return 'Windows names cannot contain < > : " | ? * or control characters';
  }
  if (/[. ]$/.test(name)) return 'Windows names cannot end in a dot or a space';
  if (WIN32_RESERVED_NAME.test(name)) return `'${name}' is a reserved device name on Windows`;
  return null;
}

function relativeSegments(root: string, candidate: string): string[] | null {
  const style = hostPathStyle(root);
  if (style !== hostPathStyle(candidate)) return null;
  if (!isAbsoluteHostPath(root) || !isAbsoluteHostPath(candidate)) return null;
  const separator = hostSeparator(style);
  const split = (path: string) => {
    const normalised = normaliseHostPath(path);
    const prefix = style === 'win32' ? splitWin32(normalised).root : '/';
    return {
      prefix,
      segments: normalised.slice(prefix.length).split(separator).filter(Boolean),
    };
  };
  const base = split(root);
  const target = split(candidate);
  const same =
    style === 'win32'
      ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      : (a: string, b: string) => a === b;
  // A UNC root is `\\server\share\`: both components must match too.
  if (!same(base.prefix.replace(/\\$/, ''), target.prefix.replace(/\\$/, ''))) return null;
  if (target.segments.length < base.segments.length) return null;
  for (const [index, segment] of base.segments.entries()) {
    if (!same(segment, target.segments[index]!)) return null;
  }
  return target.segments.slice(base.segments.length);
}

// --- Windows -----------------------------------------------------------------

/**
 * Splits a Windows path into its root and the remainder. Roots are `C:\`
 * (normalised to one backslash), a bare `C:`, `\\server\share\`, and the
 * `\\?\C:\` / `\\.\device\` namespace forms, which, like `path.win32`, are
 * treated as a server/share pair.
 */
function splitWin32(path: string): { root: string; rest: string } {
  const drive = /^([A-Za-z]:)([\\/]+)?/.exec(path);
  if (drive) {
    return { root: drive[2] ? `${drive[1]}\\` : drive[1]!, rest: path.slice(drive[0].length) };
  }
  const unc = /^[\\/]{2}([^\\/]+)(?:[\\/]+([^\\/]+))?([\\/]+|$)/.exec(path);
  if (unc?.[2]) return { root: `\\\\${unc[1]}\\${unc[2]}\\`, rest: path.slice(unc[0].length) };
  // `\\server` with no share: `path.win32` keeps it as a root-relative path.
  if (/^[\\/]/.test(path)) return { root: '\\', rest: path.replace(/^[\\/]+/, '') };
  return { root: '', rest: path };
}

function win32Normalise(path: string): string {
  const { root, rest } = splitWin32(path);
  const absolute = root.endsWith('\\');
  const trailing = /[\\/]$/.test(rest);
  const joined = normaliseSegments(rest.split(/[\\/]+/), !absolute).join('\\');
  if (joined === '') return absolute ? root : `${root}.`;
  return root + joined + (trailing ? '\\' : '');
}

// --- POSIX (identical to path.posix) -----------------------------------------

function normaliseSegments(segments: readonly string[], allowAboveRoot: boolean): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') out.push(segment);
    else if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else if (allowAboveRoot) out.push('..');
  }
  return out;
}

function posixNormalise(path: string): string {
  if (path === '') return '.';
  const absolute = path.startsWith('/');
  const trailing = path.endsWith('/');
  const joined = normaliseSegments(path.split('/'), !absolute).join('/');
  if (joined === '') return absolute ? '/' : trailing ? './' : '.';
  return (absolute ? '/' : '') + joined + (trailing ? '/' : '');
}

function posixJoin(...parts: string[]): string {
  const joined = parts.filter((part) => part !== '').join('/');
  return joined === '' ? '.' : posixNormalise(joined);
}

function posixDirname(path: string): string {
  if (path === '') return '.';
  const rooted = path.startsWith('/');
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; i--) {
    if (path[i] === '/') {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else matchedSlash = false;
  }
  if (end === -1) return rooted ? '/' : '.';
  if (rooted && end === 1) return '//';
  return path.slice(0, end);
}

function posixBasename(path: string): string {
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i] === '/') {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  return end === -1 ? '' : path.slice(start, end);
}
