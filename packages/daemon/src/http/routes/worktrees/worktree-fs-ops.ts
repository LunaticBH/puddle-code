import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { Hono } from 'hono';
import { newFileContent } from '../../../notebooks/empty.js';
import {
  copyEntryRequestSchema,
  createEntryRequestSchema,
  deleteEntryRequestSchema,
  renameEntryRequestSchema,
  transferEntryRequestSchema,
  type FsOpResponse,
} from '@puddle/shared';
import { wireRelative } from '../../../host-path.js';
import { ApiError } from '../../errors.js';
import { parseBody } from '../../validate.js';
import {
  browseRoot,
  containedPath,
  containedWritePath,
  resolveFsRoot,
  resolveWorktree,
  type WorktreeDeps,
} from './worktree-shared.js';

/**
 * The on-disk mutations the file explorer drives (SPEC §8): create,
 * rename/move, copy, delete. Every path argument is run through
 * `containedPath` (worktree-shared.ts) — the same escape-the-root guard the
 * read/upload/download routes use — before it touches the filesystem. Mounted
 * by `worktrees.ts`. Deliberately separate from the read-only `worktree-git.ts`
 * and browsing `worktree-files.ts`: these are the only client-driven writes.
 *
 * Each accepts the `?root=` override (12.3) the read routes have taken since
 * 10.2, so the parent-directory browse tree is the SAME tree as the worktree's,
 * mutations included — the paths in the body are then relative to that root and
 * the returned `path` is too.
 */

/**
 * A non-colliding sibling of `abs`, inserting ` copy`, ` copy 2`, … before the
 * extension (VSCode's paste-into-same-folder behaviour): `foo.txt` → `foo copy.txt`,
 * a folder `bar` → `bar copy`. Returns `abs` unchanged when nothing exists there.
 */
function uniqueDestination(abs: string): string {
  if (!existsSync(abs)) return abs;
  const dir = dirname(abs);
  const ext = extname(abs);
  const stem = abs.slice(dir.length + 1, abs.length - ext.length);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' copy' : ` copy ${n}`;
    const candidate = join(dir, `${stem}${suffix}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

/** True when `candidate` is `parent` itself or lexically inside it. */
function within(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Recursive force-remove. Windows retries briefly: a scanner or indexer that
 * has just opened a file makes the first attempt fail with EBUSY or EPERM.
 */
function removeTree(path: string, platform: NodeJS.Platform = process.platform): void {
  rmSync(
    path,
    platform === 'win32'
      ? { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }
      : { recursive: true, force: true },
  );
}

/** How Windows reports a file or directory that another process holds open. */
const WINDOWS_IN_USE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Runs a rename or delete, turning Windows' "in use by another process"
 * failures into 409 `path_busy` instead of an opaque 500. Windows refuses to
 * move or delete an entry while an agent, dev server, editor or terminal holds
 * it (or, for a directory, anything inside it) open; POSIX errors pass through.
 */
export function unlessInUse<T>(
  rel: string,
  run: () => T,
  platform: NodeJS.Platform = process.platform,
): T {
  try {
    return run();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (platform !== 'win32' || !WINDOWS_IN_USE.has(code)) throw error;
    throw ApiError.conflict(
      'path_busy',
      `${rel || '.'} is in use by another program (a terminal, editor or dev server); close it and try again`,
    );
  }
}

/**
 * Move across roots. rename is atomic when both roots share a filesystem; an
 * EXDEV crossing copies first and deletes only after the copy fully succeeds.
 * A failed copy cleans its partial destination and always keeps the source.
 */
function moveAcrossRoots(from: string, to: string): void {
  try {
    renameSync(from, to);
    return;
  } catch (error) {
    if (!isErrno(error, 'EXDEV')) throw error;
  }
  try {
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  } catch (error) {
    removeTree(to);
    throw error;
  }
  removeTree(from);
}

/**
 * Whether `from` and `to` name the same entry spelt differently, as a
 * case-only rename does on Windows' case-insensitive filesystems. `to` then
 * "exists" but the rename is legitimate. Always false on POSIX.
 */
export function sameEntry(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && from !== to && from.toLowerCase() === to.toLowerCase();
}

export function worktreeFsOpsRoutes(deps: WorktreeDeps): Hono {
  return new Hono()
    .post('/:sid/create', async (c) => {
      const root = browseRoot(c, resolveWorktree(deps, c).root);
      const body = await parseBody(c, createEntryRequestSchema);
      const target = containedWritePath(root, body.path);
      if (existsSync(target)) {
        throw ApiError.conflict('already_exists', `${body.path} already exists`);
      }
      if (body.kind === 'dir') {
        mkdirSync(target, { recursive: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, newFileContent(target), { flag: 'wx' });
      }
      return c.json<FsOpResponse>({ ok: true, path: wireRelative(relative(root, target)) }, 201);
    })

    .post('/:sid/rename', async (c) => {
      const root = browseRoot(c, resolveWorktree(deps, c).root);
      const body = await parseBody(c, renameEntryRequestSchema);
      const from = containedPath(root, body.from);
      const to = containedWritePath(root, body.to);
      if (!existsSync(from)) throw ApiError.notFound('path', body.from);
      if (existsSync(to) && !sameEntry(from, to)) {
        throw ApiError.conflict('already_exists', `${body.to} already exists`);
      }
      mkdirSync(dirname(to), { recursive: true });
      unlessInUse(body.from, () => renameSync(from, to));
      return c.json<FsOpResponse>({ ok: true, path: wireRelative(relative(root, to)) });
    })

    .post('/:sid/copy', async (c) => {
      const root = browseRoot(c, resolveWorktree(deps, c).root);
      const body = await parseBody(c, copyEntryRequestSchema);
      const from = containedPath(root, body.from);
      const requestedTo = containedWritePath(root, body.to);
      if (!existsSync(from)) throw ApiError.notFound('path', body.from);
      mkdirSync(dirname(requestedTo), { recursive: true });
      const to = uniqueDestination(requestedTo);
      cpSync(from, to, { recursive: true });
      return c.json<FsOpResponse>({ ok: true, path: wireRelative(relative(root, to)) }, 201);
    })

    .post('/:sid/transfer', async (c) => {
      const destinationRoot = browseRoot(c, resolveWorktree(deps, c).root);
      const body = await parseBody(c, transferEntryRequestSchema);
      const sourceRoot = resolveFsRoot(deps, body.source.session_id, body.source.root);
      const from = containedPath(sourceRoot, body.from);
      const requestedTo = containedWritePath(destinationRoot, body.to);
      if (!existsSync(from)) throw ApiError.notFound('path', body.from);

      const to = body.operation === 'copy' ? uniqueDestination(requestedTo) : requestedTo;
      if (body.operation === 'move' && existsSync(to)) {
        throw ApiError.conflict('already_exists', `${body.to} already exists`);
      }
      if (statSync(from).isDirectory() && within(from, to)) {
        throw ApiError.badRequest('invalid_destination', `cannot transfer a directory into itself`);
      }

      mkdirSync(dirname(to), { recursive: true });
      if (body.operation === 'copy') cpSync(from, to, { recursive: true });
      else unlessInUse(body.from, () => moveAcrossRoots(from, to));
      return c.json<FsOpResponse>(
        { ok: true, path: wireRelative(relative(destinationRoot, to)) },
        body.operation === 'copy' ? 201 : 200,
      );
    })

    .post('/:sid/delete', async (c) => {
      const root = browseRoot(c, resolveWorktree(deps, c).root);
      const body = await parseBody(c, deleteEntryRequestSchema);
      const target = containedPath(root, body.path);
      if (!existsSync(target)) throw ApiError.notFound('path', body.path);
      // No host trash: a recursive force-remove, mirroring the client's confirm.
      unlessInUse(body.path, () => removeTree(target));
      return c.json<FsOpResponse>({ ok: true, path: body.path });
    });
}
