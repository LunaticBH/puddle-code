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
import { ApiError } from '../../errors.js';
import { parseBody } from '../../validate.js';
import {
  browseRoot,
  containedPath,
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
    rmSync(to, { recursive: true, force: true });
    throw error;
  }
  rmSync(from, { recursive: true, force: true });
}

export function worktreeFsOpsRoutes(deps: WorktreeDeps): Hono {
  return new Hono()
    .post('/:sid/create', async (c) => {
      const root = browseRoot(c, resolveWorktree(deps, c).root);
      const body = await parseBody(c, createEntryRequestSchema);
      const target = containedPath(root, body.path);
      if (existsSync(target)) {
        throw ApiError.conflict('already_exists', `${body.path} already exists`);
      }
      if (body.kind === 'dir') {
        mkdirSync(target, { recursive: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, newFileContent(target), { flag: 'wx' });
      }
      return c.json<FsOpResponse>({ ok: true, path: relative(root, target) }, 201);
    })

    .post('/:sid/rename', async (c) => {
      const root = browseRoot(c, resolveWorktree(deps, c).root);
      const body = await parseBody(c, renameEntryRequestSchema);
      const from = containedPath(root, body.from);
      const to = containedPath(root, body.to);
      if (!existsSync(from)) throw ApiError.notFound('path', body.from);
      if (existsSync(to)) {
        throw ApiError.conflict('already_exists', `${body.to} already exists`);
      }
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      return c.json<FsOpResponse>({ ok: true, path: relative(root, to) });
    })

    .post('/:sid/copy', async (c) => {
      const root = browseRoot(c, resolveWorktree(deps, c).root);
      const body = await parseBody(c, copyEntryRequestSchema);
      const from = containedPath(root, body.from);
      const requestedTo = containedPath(root, body.to);
      if (!existsSync(from)) throw ApiError.notFound('path', body.from);
      mkdirSync(dirname(requestedTo), { recursive: true });
      const to = uniqueDestination(requestedTo);
      cpSync(from, to, { recursive: true });
      return c.json<FsOpResponse>({ ok: true, path: relative(root, to) }, 201);
    })

    .post('/:sid/transfer', async (c) => {
      const destinationRoot = browseRoot(c, resolveWorktree(deps, c).root);
      const body = await parseBody(c, transferEntryRequestSchema);
      const sourceRoot = resolveFsRoot(deps, body.source.session_id, body.source.root);
      const from = containedPath(sourceRoot, body.from);
      const requestedTo = containedPath(destinationRoot, body.to);
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
      else moveAcrossRoots(from, to);
      return c.json<FsOpResponse>(
        { ok: true, path: relative(destinationRoot, to) },
        body.operation === 'copy' ? 201 : 200,
      );
    })

    .post('/:sid/delete', async (c) => {
      const root = browseRoot(c, resolveWorktree(deps, c).root);
      const body = await parseBody(c, deleteEntryRequestSchema);
      const target = containedPath(root, body.path);
      if (!existsSync(target)) throw ApiError.notFound('path', body.path);
      // No host trash: a recursive force-remove, mirroring the client's confirm.
      rmSync(target, { recursive: true, force: true });
      return c.json<FsOpResponse>({ ok: true, path: body.path });
    });
}
