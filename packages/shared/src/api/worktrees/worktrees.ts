import { z } from 'zod';

/**
 * POST /api/worktrees/:sid/paste — a clipboard image pasted into a terminal
 * (SPEC §7). The UI sends the image as base64; the daemon writes it under
 * `.puddle/pastes/` in the session's worktree and returns the worktree-relative
 * path, which the UI inserts into the terminal's stdin (unsubmitted) so the
 * agent can read the file. This is what makes image paste work when the daemon
 * is remote: the bytes travel over the API instead of the host's clipboard.
 */
export const pasteImageMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export type PasteImageMime = z.infer<typeof pasteImageMimeSchema>;

export const pasteImageRequestSchema = z.object({
  mime: pasteImageMimeSchema,
  /** Base64-encoded image bytes (no data-URL prefix). */
  data: z.string().min(1),
});
export type PasteImageRequest = z.infer<typeof pasteImageRequestSchema>;

export const pasteImageResponseSchema = z.object({
  /** Path of the written file, relative to the worktree root. */
  path: z.string(),
});
export type PasteImageResponse = z.infer<typeof pasteImageResponseSchema>;

/**
 * GET /api/worktrees/:sid/resolve?path=…&line=… — terminal file-link
 * validation (SPEC §7). Since 15.2 the answer covers the whole daemon host,
 * not just the worktree, and directories resolve too.
 */
export const resolvePathResponseSchema = z.object({
  /**
   * The resolved identity: worktree-relative for a file inside the worktree;
   * relative to `root` for a file outside it; the ABSOLUTE directory for
   * `kind: 'dir'` (the UI binds the file tree there, it never opens an editor).
   */
  path: z.string(),
  /** Requested line echoed back, clamped to >= 1; null when absent. */
  line: z.number().int().nullable(),
  /** What resolved (15.2). Absent means `file` — pre-15.2 daemons only answered files. */
  kind: z.enum(['file', 'dir']).optional(),
  /**
   * For a directory contained by the resolution root, its root-relative path
   * (16.1). This lets Files reveal it in the existing tree instead of entering
   * an external pinned browse. Absent for directories outside that root.
   */
  relative_path: z.string().optional(),
  /**
   * Absolute browse root when the file lies OUTSIDE the worktree (15.2):
   * `path` is then relative to it — the `external` tab convention (SPEC §8).
   */
  root: z.string().optional(),
});
export type ResolvePathResponse = z.infer<typeof resolvePathResponseSchema>;
