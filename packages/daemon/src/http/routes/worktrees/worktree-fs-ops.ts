import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { Hono } from 'hono';
import { renameWithRetrySync } from '@puddle/shared/node/platform';
import { newFileContent } from '../../../notebooks/empty.js';
import {
  copyEntryRequestSchema,
  createEntryRequestSchema,
  deleteEntryRequestSchema,
  renameEntryRequestSchema,
  transferEntryRequestSchema,
  type FsOpResponse,
} from '@puddle/shared';
import { hostPathApi, wireRelative } from '../../../host-path.js';
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
 *
 * Windows takes the stem from the name itself: a drive or share root is a
 * dirname that ends in its separator, so slicing one character past it
 * dropped the name's first letter (`D:\notes.txt` → `D:\otes copy.txt`).
 */
export function uniqueDestination(
  abs: string,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (!exists(abs)) return abs;
  const path = hostPathApi(platform);
  const dir = path.dirname(abs);
  const ext = path.extname(abs);
  const stem =
    platform === 'win32'
      ? path.basename(abs, ext)
      : abs.slice(dir.length + 1, abs.length - ext.length);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' copy' : ` copy ${n}`;
    const candidate = path.join(dir, `${stem}${suffix}${ext}`);
    if (!exists(candidate)) return candidate;
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
 *
 * Only EBUSY is certainly a sharing violation. Windows reports a handle held
 * inside a directory as access denied (EPERM), exactly as it reports an ACL
 * that forbids the change, so those answers name both causes; `details.cause`
 * and the daemon's log keep the original code.
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
    const name = rel || '.';
    console.warn(`could not change ${name}: ${(error as Error).message}`);
    throw ApiError.conflict(
      'path_busy',
      code === 'EBUSY'
        ? `${name} is in use by another program (a terminal, editor or dev server); close it and try again`
        : `${name} could not be changed: it is open in another program (a terminal, editor or dev server), or you do not have permission to change it`,
      { cause: code },
    );
  }
}

/**
 * Move across roots. rename is atomic when both roots share a filesystem; an
 * EXDEV crossing copies first and deletes only after the copy fully succeeds.
 * A failed copy cleans its partial destination and always keeps the source.
 *
 * Windows cannot delete what another program holds open, and finding that out
 * only after the copy left a complete copy beside a half-deleted source, with
 * a `path_busy` that no retry could clear. So the source is first proved
 * movable with a same-volume rename, which fails for exactly those handles
 * (the probe worktree removal uses), before anything is copied. A removal that
 * still fails afterwards answers 409 `source_not_removed`: the copy is
 * complete, so the move must not read as one to retry.
 */
export function moveAcrossRoots(
  from: string,
  to: string,
  rel: string,
  platform: NodeJS.Platform = process.platform,
): void {
  try {
    renameSync(from, to);
    return;
  } catch (error) {
    if (!isErrno(error, 'EXDEV')) throw error;
  }
  if (platform === 'win32') assertMovable(from);
  try {
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  } catch (error) {
    removeTree(to, platform);
    throw error;
  }
  try {
    removeTree(from, platform);
  } catch (error) {
    if (platform !== 'win32') throw error;
    console.warn(
      `moved ${rel || '.'} but could not remove its source: ${(error as Error).message}`,
    );
    throw ApiError.conflict(
      'source_not_removed',
      `${rel || '.'} was copied, but its original could not be removed completely: something in it is open in another program (a terminal, editor or dev server), or you do not have permission to delete it`,
      { cause: (error as NodeJS.ErrnoException).code ?? '' },
    );
  }
}

/**
 * Renames `path` to an unused sibling and straight back. Throws the rename's
 * own error (EPERM or EBUSY while anything in it is open) with nothing moved.
 */
function assertMovable(path: string): void {
  const probe = `${path}.puddle-move-${process.pid}-${randomBytes(4).toString('hex')}`;
  renameSync(path, probe);
  // Nothing knows the probe name, but a scanner may glance at it: retry briefly.
  renameWithRetrySync(probe, path, 'win32');
}

/**
 * Whether `from` and `to` name the same entry spelt differently, as a
 * case-only rename does on Windows' case-insensitive filesystems. `to` then
 * "exists" but the rename is legitimate. Always false on POSIX.
 *
 * The spellings must also open one filesystem object: a directory marked
 * case-sensitive (WSL's DrvFs, `fsutil file setCaseSensitiveInfo`) holds
 * `Readme.md` and `README.md` side by side, and renaming one onto the other
 * would silently replace it. A filesystem without file ids (`ino` 0) is not
 * trusted to tell them apart, so the rename is refused there.
 */
export function sameEntry(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32' || from === to || from.toLowerCase() !== to.toLowerCase()) {
    return false;
  }
  try {
    const a = lstatSync(from, { bigint: true });
    const b = lstatSync(to, { bigint: true });
    return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
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
      else unlessInUse(body.from, () => moveAcrossRoots(from, to, body.from));
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
