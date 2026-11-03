import { z } from 'zod';

/**
 * File-explorer shapes for browsing and editing a session's worktree
 * (SPEC §6/§8, Phase 3 file transfer + editor).
 *
 * `GET /api/worktrees/:sid/tree?path=…` — list the entries of a directory.
 */
export const treeEntrySchema = z.object({
  name: z.string(),
  /**
   * The *resolved* kind: a symlink to a directory is `dir` (so it's explorable)
   * and a symlink to a file is `file` (so it opens); `symlink` is reserved for a
   * link that is broken or whose target escapes the worktree — a non-expandable
   * leaf. Pair with `symlink` to know whether the entry is itself a link.
   */
  type: z.enum(['file', 'dir', 'symlink']),
  /** Bytes on disk; null for directories and symlinks (size is meaningless there). */
  size: z.number().int().nonnegative().nullable(),
  /** The entry is a symbolic link — the tree shows the link icon at its root,
   *  regardless of the resolved `type`. Optional for wire back-compat. */
  symlink: z.boolean().default(false),
});
export type TreeEntry = z.infer<typeof treeEntrySchema>;

export const treeResponseSchema = z.object({
  path: z.string(),
  entries: z.array(treeEntrySchema),
});
export type TreeResponse = z.infer<typeof treeResponseSchema>;

/** `GET /api/worktrees/:sid/file?path=…` — read a file's content for the editor. */
export const fileResponseSchema = z.object({
  path: z.string(),
  /** Null when `binary` is true — binary bytes never travel as JSON text. */
  content: z.string().nullable(),
  binary: z.boolean(),
  size: z.number().int().nonnegative(),
  mtime_ms: z.number(),
});
export type FileResponse = z.infer<typeof fileResponseSchema>;

/** Bounded JSON assets fit inside the encrypted remote response limit after base64. */
export const MAX_PREVIEW_ASSET_BYTES = 8 * 1024 * 1024;
export const previewAssetResponseSchema = z.object({
  mime: z.string().min(1).max(128),
  data: z.string().max(4 * Math.ceil(MAX_PREVIEW_ASSET_BYTES / 3)),
});
export type PreviewAssetResponse = z.infer<typeof previewAssetResponseSchema>;

/** `PUT /api/worktrees/:sid/file?path=…` — save editor content back to disk. */
export const putFileRequestSchema = z.object({
  content: z.string(),
  /** Optimistic-concurrency guard: reject the write if the file changed since this mtime. */
  expected_mtime_ms: z.number().optional(),
});
export type PutFileRequest = z.infer<typeof putFileRequestSchema>;

export const putFileResponseSchema = z.object({
  path: z.string(),
  mtime_ms: z.number(),
  size: z.number().int().nonnegative(),
});
export type PutFileResponse = z.infer<typeof putFileResponseSchema>;

/**
 * `POST /api/worktrees/:sid/upload?dir=…` — drop OS files onto an explorer
 * folder; the daemon writes them under `dir` and reports what landed.
 *
 * `GET /api/worktrees/:sid/download?path=…` streams raw bytes (a file, or a
 * zip for a directory) and has no JSON response shape to schema.
 */
export const uploadResponseSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      size: z.number().int().nonnegative(),
    }),
  ),
});
export type UploadResponse = z.infer<typeof uploadResponseSchema>;
