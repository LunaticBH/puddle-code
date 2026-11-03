import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Hono } from 'hono';
import { MAX_PREVIEW_ASSET_BYTES, type PreviewAssetResponse } from '@puddle/shared';
import { ApiError } from '../../errors.js';
import { mediaMime } from './media-mime.js';
import {
  browseRoot,
  containedPath,
  resolveWorktree,
  type WorktreeDeps,
} from './worktree-shared.js';

/** The existing browse boundary, with a bounded, JSON-only representation for remote viewers. */
export function worktreePreviewRoutes(deps: WorktreeDeps): Hono {
  return new Hono().get('/:sid/preview-asset', async (c) => {
    const root = browseRoot(c, resolveWorktree(deps, c).root);
    const path = c.req.query('path') ?? '';
    const target = containedPath(root, path);
    // Nonblocking open avoids hanging on a FIFO before we can reject non-files.
    const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK).catch(
      (error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
          throw ApiError.notFound('file', path);
        throw error;
      },
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw ApiError.badRequest('not_a_file', `${path} is not a file`);
      const tooLarge = () =>
        new ApiError(413, 'preview_too_large', 'Preview assets must be 8 MiB or smaller.');
      if (stat.size > MAX_PREVIEW_ASSET_BYTES) throw tooLarge();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        size += chunk.length;
        // Recheck streamed bytes: a file may grow after stat.
        if (size > MAX_PREVIEW_ASSET_BYTES) throw tooLarge();
        chunks.push(chunk);
      }
      c.header('Cache-Control', 'no-store');
      return c.json<PreviewAssetResponse>({
        mime: mediaMime(path) ?? 'application/octet-stream',
        data: Buffer.concat(chunks).toString('base64'),
      });
    } finally {
      await file.close();
    }
  });
}
