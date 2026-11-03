import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, posix, sep, win32 } from 'node:path';
import type { Context } from 'hono';
import { isInsideHostPath, windowsNameProblem, type Session } from '@puddle/shared';
import type { RepoStore } from '../../../db/stores/repos.js';
import type { SessionStore } from '../../../db/stores/sessions.js';
import { canonicalHostPath, isNativeAbsolute, rootBareDrive } from '../../../host-path.js';
import type { WorktreeManager } from '../../../worktrees/manager.js';
import { ApiError } from '../../errors.js';
import { expandTilde } from '../../tilde.js';

/**
 * The nil uuid in place of a `:sid` names NO session — a **directory target**
 * (protocol 12.4). The route then works against the absolute `?root=` it is
 * given instead of a session's worktree, which is what lets the left sidebar
 * bind to a project's own repository directory: a project with no sessions (or
 * none in focus) used to leave Files, Changes, and Search showing nothing at
 * all. `root` is REQUIRED with it; a real session id behaves exactly as before,
 * `?root=` override included.
 *
 * The nil uuid is deliberate rather than a new id syntax: it is already a
 * wire-valid `sessionId` (the untitled-draft convention, protocol 10.3, uses it
 * the same way — "no session applies"), so an `external` tab opened from a
 * project directory round-trips through `uiStateSnapshotSchema` on any client,
 * and nothing about the persisted shapes had to change.
 */
export const NO_SESSION = '00000000-0000-0000-0000-000000000000';

export interface WorktreeTarget {
  /** The session, when the target is one; null for a directory target. */
  session: Session | null;
  /** The directory the route operates on. */
  root: string;
  /**
   * What a `base` diff compares against: the session's base branch, or — for a
   * directory target — the default of the repo registered at that path.
   */
  baseBranch: string;
}

export interface WorktreeDeps {
  sessions: SessionStore;
  repos: RepoStore;
  /** Present in the full daemon; narrow route tests may use the service fallback. */
  worktrees?: Pick<WorktreeManager, 'runGitMutation'>;
}

/** Validate a client-supplied absolute directory (`?root=`), tilde expanded. */
export function absoluteDir(raw: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return absoluteWindowsDir(raw);
  const root = normalize(expandTilde(raw));
  if (!isAbsolute(root)) {
    throw ApiError.badRequest('invalid_root', `'root' must be an absolute path`);
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw ApiError.notFound('root', raw);
  }
  // Canonical: no trailing separator, except for the filesystem root itself,
  // which IS one. Keeps roots comparable and the containment prefix honest.
  return root.length > 1 && root.endsWith(sep) ? root.slice(0, -1) : root;
}

/**
 * Windows roots are drive or UNC paths in either separator (`\x` and `/x`
 * would silently mean the daemon's current drive). A bare `C:` is the drive
 * root, which is also where browsing stops: there is no virtual list of
 * drives. The result is canonical (decision 11) and, like POSIX, keeps a
 * trailing separator only when it is a drive or share root.
 */
function absoluteWindowsDir(raw: string): string {
  const root = rootBareDrive(expandTilde(raw, 'win32'), 'win32');
  if (!isNativeAbsolute(root, 'win32')) {
    throw ApiError.badRequest('invalid_root', `'root' must be an absolute path`);
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw ApiError.notFound('root', raw);
  }
  const canonical = canonicalHostPath(root, 'win32');
  return canonical.endsWith('\\') && canonical !== win32.parse(canonical).root
    ? canonical.slice(0, -1)
    : canonical;
}

/**
 * Resolve the filesystem root named by a session/root pair outside a request
 * context. Cross-filetree transfer needs this for its independently identified
 * source; ordinary routes continue resolving their destination from the URL.
 */
export function resolveFsRoot(deps: WorktreeDeps, sid: string, rootOverride?: string): string {
  if (sid === NO_SESSION) {
    if (rootOverride === undefined || rootOverride === '') {
      throw ApiError.badRequest(
        'root_required',
        `a directory target (the nil session id) requires 'root'`,
      );
    }
    return absoluteDir(rootOverride);
  }
  const session = deps.sessions.get(sid);
  if (!existsSync(session.worktree_path)) {
    throw ApiError.conflict('worktree_missing', `session ${session.id} has no worktree on disk`);
  }
  return rootOverride === undefined || rootOverride === ''
    ? session.worktree_path
    : absoluteDir(rootOverride);
}

/**
 * Shared guard for every worktree-scoped route. For a session target the
 * session must exist (`SessionStore.get` throws 404) and its worktree must
 * still be on disk (409 `worktree_missing` otherwise — e.g. archived-and-
 * removed, or force-removed out of band). For the nil uuid see `NO_SESSION`.
 */
export function resolveWorktree(deps: WorktreeDeps, c: Context): WorktreeTarget {
  const sid = c.req.param('sid') ?? '';
  if (sid === NO_SESSION) {
    const raw = c.req.query('root');
    if (raw === undefined || raw === '') {
      throw ApiError.badRequest(
        'root_required',
        `a directory target (the nil session id) requires 'root'`,
      );
    }
    const root = absoluteDir(raw);
    // A project's directory is always a registered repo, so its own default
    // base branch is the honest comparison. A directory that is NOT a
    // registered repo (a parent-directory browse) has no base: `HEAD` makes a
    // `base` diff read as "nothing ahead" instead of erroring.
    return {
      session: null,
      root,
      baseBranch: deps.repos.getByPath(root)?.default_base_branch ?? 'HEAD',
    };
  }
  const session = deps.sessions.get(sid);
  if (!existsSync(session.worktree_path)) {
    throw ApiError.conflict('worktree_missing', `session ${session.id} has no worktree on disk`);
  }
  return { session, root: session.worktree_path, baseBranch: session.base_branch };
}

/**
 * The effective root for the file routes (protocol 10.2, writes 10.4,
 * mutations 12.3, git 12.4): an optional absolute `?root=` query overrides the
 * session's worktree so the explorer can walk parent directories and browse them
 * with the SAME tree it gives the worktree — read, save, create, rename, copy,
 * delete, upload, download (SPEC §8). Trusted single-user box — the token
 * holder already has a shell, so touching files anywhere grants nothing new
 * (the same rationale as `GET /api/fs/dirs`). Paths under the override still
 * go through `containedPath` against the OVERRIDDEN root, so a relative path
 * can never escape the directory the client is actually looking at.
 */
export function browseRoot(c: Context, worktreeRoot: string): string {
  const raw = c.req.query('root');
  if (raw === undefined || raw === '') return worktreeRoot;
  return absoluteDir(raw);
}

/**
 * Resolve a client-supplied `rel` path against the effective `root`, rejecting
 * path-injection escapes. Mirrors the confinement check in `src/http/static.ts`
 * (normalise-then-prefix-check): the `rel` must be relative and must not use
 * `..` to climb above `root` — the caller can never name a path outside the
 * root directly.
 *
 * Symlinks ARE followed, even when their target lives outside the worktree: a
 * symlink is a real filesystem object the user (or their tools) placed in the
 * worktree, so following it is intended — `./workspaces` linked to a shared dir
 * browses and edits as expected. The `..` normalisation happens lexically,
 * BEFORE any symlink is resolved, so it can only cancel earlier path segments,
 * never walk the external filesystem: through a symlink you reach exactly the
 * target and its subtree, nothing beside or above it. This is a deliberate
 * relaxation of an earlier realpath-based escape guard — puddle runs as the
 * user, who already has shell access to whatever a worktree symlink points at.
 */
export function containedPath(
  root: string,
  rel: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') return containedWindowsPath(root, rel);
  if (isAbsolute(rel)) {
    // The code stays `path_outside_worktree` (a wire contract since 3.x) even
    // under a `?root=` override, where "worktree" is really "the browse root".
    throw ApiError.badRequest('path_outside_worktree', `path must be relative to ${root}`);
  }
  const candidate = normalize(join(root, rel));
  // The prefix is the root with EXACTLY one trailing separator. Appending one
  // unconditionally breaks the two roots that already end in it: browsing at
  // the filesystem root made the prefix `//`, so every child of `/` — every
  // path reachable by walking to the top of the browse tree — was rejected as
  // an escape. Deriving it instead keeps the guard identical everywhere else
  // (`/wt` still admits `/wt/x` and still rejects `/wt-evil`).
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(prefix)) {
    throw ApiError.badRequest('path_outside_worktree', `path escapes ${root}`);
  }
  return candidate;
}

/**
 * The Windows confinement check: `rel` may use either separator, but neither a
 * drive (`C:\x`, or the drive-relative `D:x`) nor a root (`\x`). Containment
 * compares segments case-insensitively across separators, so a root stored as
 * `C:/x/wt` or `c:\x\WT` still contains its own children.
 */
function containedWindowsPath(root: string, rel: string): string {
  if (win32.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw ApiError.badRequest('path_outside_worktree', `path must be relative to ${root}`);
  }
  const candidate = win32.normalize(win32.join(root, rel));
  if (!isInsideHostPath(root, candidate)) {
    throw ApiError.badRequest('path_outside_worktree', `path escapes ${root}`);
  }
  return candidate;
}

/**
 * `containedPath` for a path about to be CREATED (a new file, a rename or copy
 * destination, an upload): on Windows every segment must also be a name
 * Windows can store, or the request fails with 400 `invalid_name` before
 * anything is written. Existing entries stay readable whatever their names.
 */
export function containedWritePath(
  root: string,
  rel: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const candidate = containedPath(root, rel, platform); // escapes are reported as escapes
  if (platform === 'win32') assertStorableName(rel);
  return candidate;
}

/** Throws 400 `invalid_name` unless every segment of `rel` is a name Windows can store. */
export function assertStorableName(rel: string): void {
  for (const segment of rel.split(/[\\/]/)) {
    const problem = segment === '' ? null : windowsNameProblem(segment);
    if (problem) {
      throw ApiError.badRequest('invalid_name', `'${rel}' cannot be created: ${problem}`);
    }
  }
}

/**
 * Relative-path guard for the git blob routes (`file-at`, `index-file`,
 * `git-original`): the path keys a git blob, not a filesystem entry, so
 * `containedPath`'s root doesn't apply here — the path may not exist on disk
 * at all (e.g. a file deleted since `ref`). A normalise-then-prefix check
 * against a virtual root is enough to reject an absolute path or a
 * `..`-escape. Windows works in `path.posix` on the `/` spelling, because the
 * result names a git path (`<ref>:<path>`), never a host path.
 */
export function gitRelativePath(rel: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return posixGitPath(rel.replaceAll('\\', '/'), /^[A-Za-z]:/.test(rel));
  if (isAbsolute(rel)) {
    throw ApiError.badRequest('path_outside_worktree', `path must be relative to the worktree`);
  }
  const virtualRoot = '/virtual-root';
  const joined = normalize(join(virtualRoot, rel));
  if (joined !== virtualRoot && !joined.startsWith(virtualRoot + sep)) {
    throw ApiError.badRequest('path_outside_worktree', `path escapes the worktree`);
  }
  return joined === virtualRoot ? '' : joined.slice(virtualRoot.length + 1);
}

function posixGitPath(rel: string, hasDrive: boolean): string {
  if (hasDrive || posix.isAbsolute(rel)) {
    throw ApiError.badRequest('path_outside_worktree', `path must be relative to the worktree`);
  }
  const virtualRoot = '/virtual-root';
  const joined = posix.normalize(posix.join(virtualRoot, rel));
  if (joined !== virtualRoot && !joined.startsWith(`${virtualRoot}/`)) {
    throw ApiError.badRequest('path_outside_worktree', `path escapes the worktree`);
  }
  return joined === virtualRoot ? '' : joined.slice(virtualRoot.length + 1);
}
