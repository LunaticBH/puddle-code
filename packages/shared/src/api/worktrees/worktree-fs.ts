import { z } from 'zod';
import { sessionId } from '../common.js';

/**
 * Worktree file-*mutation* shapes (SPEC §8): create, rename/move, copy, and
 * delete of files and folders. Deliberately separate from the read-only
 * browsing shapes in `worktree-files.ts` and the read-only git inspection in
 * `worktree-git.ts` — these are the only endpoints that change the worktree's
 * on-disk layout from the client. Every `path`/`from`/`to` is validated
 * server-side against the worktree root (see `containedPath`).
 *
 * Root-relative paths travel with `/` on every host, Windows included; a
 * Windows daemon also accepts `\` on input. There it answers 400
 * `invalid_name` for a new name Windows cannot store (reserved device names,
 * `<>:"|?*`, a trailing dot or space) and 409 `path_busy` when another program
 * holds the entry open.
 */

/** `POST /api/worktrees/:sid/create` — an empty file or a `mkdir -p` folder. */
export const createEntryRequestSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['file', 'dir']),
});
export type CreateEntryRequest = z.infer<typeof createEntryRequestSchema>;

/** `POST /api/worktrees/:sid/rename` — one `fs.rename`, serving both rename and move. */
export const renameEntryRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type RenameEntryRequest = z.infer<typeof renameEntryRequestSchema>;

/** `POST /api/worktrees/:sid/copy` — recursive copy; `to` is auto-suffixed on collision. */
export const copyEntryRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type CopyEntryRequest = z.infer<typeof copyEntryRequestSchema>;

/**
 * `POST /api/worktrees/:sid/transfer` — copy or move one entry from another
 * filetree into the URL-addressed destination tree. `source.root` has the same
 * meaning as the routes' `?root=` override; absent means the source session's
 * worktree. One entry per request keeps partial multi-selection failures
 * explicit at the client. A Windows daemon whose move to another drive copied
 * everything but could not remove the whole source answers 409
 * `source_not_removed`.
 */
export const transferEntryRequestSchema = z.object({
  operation: z.enum(['copy', 'move']),
  source: z.object({
    session_id: sessionId,
    root: z.string().optional(),
  }),
  from: z.string().min(1),
  to: z.string().min(1),
});
export type TransferEntryRequest = z.infer<typeof transferEntryRequestSchema>;

/** `POST /api/worktrees/:sid/delete` — recursive remove (no host trash). */
export const deleteEntryRequestSchema = z.object({
  path: z.string().min(1),
});
export type DeleteEntryRequest = z.infer<typeof deleteEntryRequestSchema>;

/**
 * Shared response for every mutation: `path` is the resulting worktree-relative
 * path — the created entry, the new name after a rename/move, or (for copy) the
 * final auto-suffixed destination the caller should reveal/select.
 */
export const fsOpResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string(),
});
export type FsOpResponse = z.infer<typeof fsOpResponseSchema>;
