import { hostDirname, hostJoin, hostPathStyle, type TreeResponse } from '@puddle/shared';

/**
 * Pure, DOM-free helpers for the file explorer (SPEC §8): worktree-relative
 * path arithmetic, the flattened visible-row model that multi-select ranges and
 * arrow-key navigation walk, and the range between two rows. Kept apart from the
 * React provider so it is unit-testable.
 */

export interface VisibleRow {
  /** Worktree-relative path. */
  path: string;
  name: string;
  type: 'file' | 'dir' | 'symlink';
  /** Indent depth: root children are 0. */
  depth: number;
  /** Parent directory (worktree-relative; '' for a root child). */
  parentDir: string;
}

/** Last path segment. `basename('a/b/c.txt') === 'c.txt'`. */
export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Parent directory, '' for a root-level path. `dirOf('a/b') === 'a'`. */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/**
 * Every directory between the root and `path`, outermost first —
 * `ancestorDirs('a/b/c.ts') === ['a', 'a/b']`. What a reveal has to expand to
 * bring a row into the tree (the root itself is always expanded, so it is not
 * in the list).
 */
export function ancestorDirs(path: string): string[] {
  const parts = path.split('/').filter((p) => p !== '');
  parts.pop(); // the leaf names the file (or the directory being revealed) itself
  const out: string[] = [];
  for (const part of parts) out.push(joinPath(out[out.length - 1] ?? '', part));
  return out;
}

/**
 * Parent of an ABSOLUTE host directory path; '/' is its own parent, and so is
 * a Windows drive root (`C:\`) or UNC share: browsing stops there
 * (docs/windows.md, decision 11).
 */
export function parentDir(dir: string): string {
  if (hostPathStyle(dir) === 'win32') return hostDirname(dir);
  const cut = dir.replace(/\/+$/, '');
  const idx = cut.lastIndexOf('/');
  return idx <= 0 ? '/' : cut.slice(0, idx);
}

/** Join a directory and a name into a worktree-relative path. */
export function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/**
 * Join an absolute directory to one of the explorer's root-relative paths. A
 * Windows root gets native separators throughout (`C:\repo\src\a.ts`), so the
 * result matches the daemon's canonical form for the same file.
 */
export function joinAbsolutePath(root: string, path: string): string {
  if (path === '') return root;
  if (hostPathStyle(root) === 'win32') return hostJoin(root, path);
  return `${root.replace(/\/+$/, '')}/${path}`;
}

/**
 * What "Copy Path" (absolute) or "Copy Relative Path" writes for a row.
 * Relative paths stay `/`-separated on every host; a Windows host's absolute
 * path is native, and its root row is the root itself (`C:\repo`).
 */
export function copyablePath(root: string, path: string, relative: boolean): string {
  if (relative) return path;
  return hostPathStyle(root) === 'win32' ? joinAbsolutePath(root, path) : joinPath(root, path);
}

/**
 * Return `path` relative to an absolute `root` when it is already represented
 * by that tree, as a `/`-separated root-relative path. Segment boundaries
 * matter: `/repo-copy` is not inside `/repo`. A Windows host's native `\`
 * paths are accepted and compared case-insensitively.
 */
export function relativePathWithinAbsoluteRoot(root: string, path: string): string | null {
  const normalise = (value: string) => {
    const slashed = value.replaceAll('\\', '/');
    const trimmed = slashed.replace(/\/+$/, '');
    return trimmed === '' ? '/' : trimmed;
  };
  const normalisedRoot = normalise(root);
  const normalisedPath = normalise(path);
  const windowsPath = /^[A-Za-z]:($|\/)/.test(normalisedRoot);
  const comparableRoot = windowsPath ? normalisedRoot.toLocaleLowerCase('en-US') : normalisedRoot;
  const comparablePath = windowsPath ? normalisedPath.toLocaleLowerCase('en-US') : normalisedPath;
  if (comparablePath === comparableRoot) return '';

  const prefix = comparableRoot === '/' ? '/' : `${comparableRoot}/`;
  if (!comparablePath.startsWith(prefix)) return null;
  return normalisedPath.slice(prefix.length);
}

/** True when `path` is `ancestor` itself or lies inside it — used to forbid moving a folder into its own subtree. */
export function isInside(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/**
 * Drop every path whose ancestor is also in the set, keeping input order — a
 * multi-selection holding both a folder and its child must act on the folder
 * once (moving/copying/deleting the parent already covers the child; acting on
 * the child separately would double-copy or fail on the already-gone path).
 */
export function pruneNested(paths: readonly string[]): string[] {
  const set = new Set(paths);
  return paths.filter((p) => {
    if (p === '') return true; // the worktree root — nothing above it
    for (let dir = dirOf(p); ; dir = dirOf(dir)) {
      if (set.has(dir)) return false;
      if (dir === '') return true;
    }
  });
}

/** DataTransfer type for internal tree drags: a JSON array of worktree-relative paths. */
export const EXPLORER_DRAG_MIME = 'application/x-puddle-paths';

export function encodeDragPaths(paths: readonly string[]): string {
  return JSON.stringify(paths);
}

/** Decode a drag payload; [] when the data is absent or not ours. */
export function decodeDragPaths(data: string): string[] {
  try {
    const parsed: unknown = JSON.parse(data);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Flatten the loaded-and-expanded tree into an ordered visible-row list.
 * `read(dir)` returns the cached `TreeResponse` for a directory (or undefined
 * if not yet loaded); a directory contributes children only when it is in
 * `expanded` AND its data is present, so a just-expanded folder simply adds no
 * rows until its query resolves.
 */
export function buildVisibleRows(
  read: (dir: string) => TreeResponse | undefined,
  expanded: ReadonlySet<string>,
): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (dir: string, depth: number) => {
    const data = read(dir);
    if (!data) return;
    for (const entry of data.entries) {
      const path = joinPath(dir, entry.name);
      out.push({ path, name: entry.name, type: entry.type, depth, parentDir: dir });
      if (entry.type === 'dir' && expanded.has(path)) walk(path, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

/** The inclusive set of paths between two rows in visible order (for shift-click / shift-arrow). */
export function rangeBetween(rows: readonly VisibleRow[], a: string, b: string): string[] {
  const ia = rows.findIndex((r) => r.path === a);
  const ib = rows.findIndex((r) => r.path === b);
  if (ia === -1 || ib === -1) return b ? [b] : [];
  const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
  return rows.slice(lo, hi + 1).map((r) => r.path);
}
