import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Hono } from 'hono';
import {
  pasteImageRequestSchema,
  type PasteImageMime,
  type PasteImageResponse,
  type ResolvePathResponse,
} from '@puddle/shared';
import { canonicalHostPath, wireRelative } from '../../../host-path.js';
import { ApiError } from '../../errors.js';
import { expandTilde } from '../../tilde.js';
import { parseBody } from '../../validate.js';
import { worktreePreviewRoutes } from './worktree-preview.js';
import { worktreeFileRoutes } from './worktree-files.js';
import { worktreeFsOpsRoutes } from './worktree-fs-ops.js';
import { worktreeGitRoutes } from './worktree-git.js';
import { resolveWorktree, type WorktreeDeps } from './worktree-shared.js';
import { refusesForeignNetworkPath } from './windows-paths.js';

/** Decoded-size cap for pasted images; generous for screenshots, hostile to abuse. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const EXTENSION: Record<PasteImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** The canonical spelling of a directory, or the raw one when it has none. */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Worktree-scoped routes (SPEC §6, Files): thin aggregator over the
 * clipboard-paste target (§7), the tree/file/upload/download browsing family
 * (§8, `worktree-files.ts`), the create/rename/copy/delete mutation family
 * (§8, `worktree-fs-ops.ts`), and the read-only git inspection family
 * (diff/git-status/file-at/log/show, `worktree-git.ts`).
 */
export function worktreeRoutes(deps: WorktreeDeps): Hono {
  const app = new Hono();

  app.post('/:sid/paste', async (c) => {
    const { root } = resolveWorktree(deps, c);
    const body = await parseBody(c, pasteImageRequestSchema);
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.byteLength === 0) {
      throw ApiError.badRequest('invalid_image', `'data' is not valid base64`);
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw ApiError.badRequest(
        'image_too_large',
        `pasted image is ${bytes.byteLength} bytes; the cap is ${MAX_IMAGE_BYTES}`,
      );
    }

    // .puddle/ is git-excluded per repo (worktree manager), so pastes never
    // show up in diffs or commits. Timestamp + random suffix: unique without
    // coordination, and sorts chronologically for humans.
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const name = `paste-${stamp}-${randomBytes(3).toString('hex')}.${EXTENSION[body.mime]}`;
    const dir = join(root, '.puddle', 'pastes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), bytes);

    return c.json<PasteImageResponse>({ path: `.puddle/pastes/${name}` }, 201);
  });

  // GET /:sid/resolve — validates a terminal file-path link before the UI
  // underlines it (SPEC §7, "Terminal links"): the xterm.js link provider
  // asks here on hover, so this must be cheap. Since 15.2 the answer covers
  // the WHOLE daemon host, not just the worktree — the browse machinery
  // (12.3/12.4) already serves any absolute `?root=`, so confirming that a
  // host path exists is not a capability this endpoint adds — and a
  // directory resolves too, which the UI binds the file tree to as a pinned
  // browse (SPEC §8). Only a path that names nothing 404s.
  app.get('/:sid/resolve', async (c) => {
    const { root } = resolveWorktree(deps, c);
    const rawPath = c.req.query('path');
    if (!rawPath) {
      throw ApiError.badRequest('invalid_request', `'path' query parameter is required`);
    }

    // Relative paths resolve against the worktree (the terminal's cwd at
    // spawn); `~` against the daemon host's home, exactly as the shell the
    // agent printed it from would expand it.
    const abs = resolve(root, expandTilde(rawPath));
    // Windows: a network or device path from terminal output is never
    // opened unless it lies in the session's own tree (windows-paths.ts).
    if (refusesForeignNetworkPath(abs, () => [root, safeRealpath(root), canonicalHostPath(root)])) {
      throw ApiError.notFound('path', rawPath);
    }
    // Symlinks are followed, even out of the worktree — consistent with the
    // file explorer / `containedPath`. The raw (unresolved) `abs` keeps a
    // symlinked-out file reading as INSIDE the worktree below, exactly as
    // the explorer treats it. Asynchronous, so a slow volume cannot hold up
    // every other session's terminal while the hover waits.
    let stats: Stats;
    try {
      stats = await stat(abs);
    } catch {
      throw ApiError.notFound('path', rawPath);
    }

    const lineParam = c.req.query('line');
    const parsedLine = lineParam === undefined ? NaN : Number.parseInt(lineParam, 10);
    const line = Number.isNaN(parsedLine) ? null : Math.max(1, parsedLine);

    // A directory has no editor to open into. Keep its absolute identity for
    // the external pinned-browse path, and additionally identify one contained
    // by the current resolution root so Files can reveal it in place (16.1).
    // Absolute answers are canonical and relative ones `/`-separated on every
    // host (decision 11); both are identities on POSIX.
    if (stats.isDirectory()) {
      for (const base of [root, safeRealpath(root)]) {
        const rel = relative(base, abs);
        if (!rel.startsWith('..') && !isAbsolute(rel)) {
          return c.json<ResolvePathResponse>({
            path: canonicalHostPath(abs),
            line: null,
            kind: 'dir',
            relative_path: wireRelative(rel),
          });
        }
      }
      return c.json<ResolvePathResponse>({ path: canonicalHostPath(abs), line: null, kind: 'dir' });
    }
    if (!stats.isFile()) {
      throw ApiError.notFound('path', rawPath); // fifos, sockets, devices
    }

    // Worktree containment decides the SHAPE of the answer, not whether there
    // is one: inside → the worktree-relative identity every other endpoint
    // uses; outside → external-tab coordinates (an absolute root plus the
    // name relative to it — the browse convention, SPEC §8). Checked against
    // the raw root and its realpath: on macOS the worktree commonly sits
    // behind a symlinked tmpdir (/tmp -> /private/tmp) and an agent may print
    // either spelling, both of which must read as "inside".
    for (const base of [root, safeRealpath(root)]) {
      const rel = relative(base, abs);
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
        return c.json<ResolvePathResponse>({ path: wireRelative(rel), line, kind: 'file' });
      }
    }
    return c.json<ResolvePathResponse>({
      path: basename(abs),
      root: canonicalHostPath(dirname(abs)),
      line,
      kind: 'file',
    });
  });

  app.route('/', worktreeFileRoutes(deps));
  app.route('/', worktreePreviewRoutes(deps));
  app.route('/', worktreeFsOpsRoutes(deps));
  app.route('/', worktreeGitRoutes(deps));
  return app;
}
