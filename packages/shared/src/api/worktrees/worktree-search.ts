import { z } from 'zod';

/**
 * Worktree search shapes (SPEC §8, Search navigator). One request returns
 * both filename matches and in-file content matches (Obsidian-style), so the
 * navigator can show a "Files" section and a "Contents" section from a single
 * query. Content search is `git grep` over tracked + untracked-not-ignored
 * files; filename search subsequence-matches the same file set.
 */

/** A single content match within a file: 1-based `line`, the raw line `text`. */
export const searchMatchSchema = z.object({
  line: z.number().int().positive(),
  text: z.string(),
});
export type SearchMatch = z.infer<typeof searchMatchSchema>;

/** One file's content matches, in file order. */
export const searchFileMatchesSchema = z.object({
  path: z.string(),
  matches: z.array(searchMatchSchema),
});
export type SearchFileMatches = z.infer<typeof searchFileMatchesSchema>;

/**
 * `GET /api/worktrees/:sid/search?q=…&regex=…&case=…&word=…` — filename and
 * content matches for one worktree. `truncated` is set when either list hit
 * its server cap, so the UI can say "showing the first N".
 */
export const searchResponseSchema = z.object({
  query: z.string(),
  /** Files whose path matched the query (name search). */
  files: z.array(z.string()),
  /** Files with content matches, each carrying its matching lines. */
  content: z.array(searchFileMatchesSchema),
  /** True when the file list or content matches were capped. */
  truncated: z.boolean(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
