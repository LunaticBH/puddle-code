import { z } from 'zod';
import { isoTimestamp } from '../common.js';

/**
 * Git-inspection shapes for a session's worktree — diff, blame-free file
 * lookups at a ref, and commit history (SPEC §6/§8, Phase 3 history view).
 */
export const diffStatusSchema = z.enum(['added', 'modified', 'deleted', 'renamed']);
export type DiffStatus = z.infer<typeof diffStatusSchema>;

/** Which Git snapshot pair an uncommitted diff represents (protocol 15.3). */
export const gitAreaSchema = z.enum(['staged', 'unstaged']);
export type GitArea = z.infer<typeof gitAreaSchema>;

export const diffEntrySchema = z.object({
  path: z.string(),
  status: diffStatusSchema,
  /** Pre-rename path; null unless `status` is `renamed`. */
  old_path: z.string().nullable(),
});
export type DiffEntry = z.infer<typeof diffEntrySchema>;

/** `GET /api/worktrees/:sid/diff?against=base|<sha>` — working tree vs. a base. */
export const diffResponseSchema = z.object({
  /** The resolved sha the working tree was actually diffed against. */
  against: z.string(),
  /** e.g. `origin/main`; null when `against` was given as a literal sha. */
  base_ref: z.string().nullable(),
  entries: z.array(diffEntrySchema),
  /** Present for the 15.3 index-aware diff modes; absent on legacy diffs. */
  area: gitAreaSchema.optional(),
});
export type DiffResponse = z.infer<typeof diffResponseSchema>;

/**
 * Per-path working-tree status for the file explorer's decorations (SPEC §8),
 * distinct from `diffStatusSchema`: the tree needs the full VSCode-grade set,
 * including `untracked` (which the diff view folds into `added`), `conflicted`,
 * and `ignored` (so ignored-but-present files can be greyed).
 */
export const gitStatusSchema = z.enum([
  'untracked',
  'modified',
  'added',
  'deleted',
  'renamed',
  'conflicted',
  'ignored',
]);
export type GitStatus = z.infer<typeof gitStatusSchema>;

export const gitStatusEntrySchema = z.object({
  path: z.string(),
  status: gitStatusSchema,
});
export type GitStatusEntry = z.infer<typeof gitStatusEntrySchema>;

/** `GET /api/worktrees/:sid/git-status` — every changed/untracked/ignored path in the worktree. */
export const gitStatusResponseSchema = z.object({
  entries: z.array(gitStatusEntrySchema),
});
export type GitStatusResponse = z.infer<typeof gitStatusResponseSchema>;

/** One repository-relative path in a source-control group (protocol 15.3). */
export const gitChangeEntrySchema = z.object({
  path: z.string(),
  status: gitStatusSchema.exclude(['ignored']),
  /** Pre-rename path; null unless Git reported a rename or copy. */
  old_path: z.string().nullable(),
});
export type GitChangeEntry = z.infer<typeof gitChangeEntrySchema>;

/**
 * One Git worktree intersecting the visible browse root. `root` is absolute so
 * the existing `?root=` file/diff routes can bind directly to nested repos or
 * to an owning repo above the visible directory.
 */
export const gitRepositorySchema = z.object({
  root: z.string(),
  /** Path from the visible root (`.` for the same directory; may start `..`). */
  relative_path: z.string(),
  name: z.string(),
  owning: z.boolean(),
  submodule: z.boolean(),
  initialised: z.boolean(),
  head: z.string().nullable(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  has_remote: z.boolean(),
  staged: z.array(gitChangeEntrySchema),
  unstaged: z.array(gitChangeEntrySchema),
  conflicts: z.array(gitChangeEntrySchema),
});
export type GitRepository = z.infer<typeof gitRepositorySchema>;

/** `GET /api/worktrees/:sid/git-repositories` (protocol 15.3). */
export const gitRepositoriesResponseSchema = z.object({
  repositories: z.array(gitRepositorySchema),
  /** Explorer decorations, rebased from every repository to the visible root. */
  entries: z.array(gitStatusEntrySchema),
});
export type GitRepositoriesResponse = z.infer<typeof gitRepositoriesResponseSchema>;

/** Repository identity shared by every source-control mutation. */
export const gitRepositoryRequestSchema = z.object({ repository: z.string().min(1) });
export type GitRepositoryRequest = z.infer<typeof gitRepositoryRequestSchema>;

export const gitPathsRequestSchema = gitRepositoryRequestSchema.extend({
  paths: z.array(z.string().min(1)).min(1),
});
export type GitPathsRequest = z.infer<typeof gitPathsRequestSchema>;

export const gitCommitRequestSchema = gitRepositoryRequestSchema.extend({
  message: z.string().trim().min(1),
  /** Stage every change immediately before committing, under the same repo lock. */
  stage_all: z.boolean().optional(),
});
export type GitCommitRequest = z.infer<typeof gitCommitRequestSchema>;

export const gitPushRequestSchema = gitRepositoryRequestSchema.extend({
  /** Publish the current named branch and establish its upstream. */
  set_upstream: z.boolean().optional(),
});
export type GitPushRequest = z.infer<typeof gitPushRequestSchema>;

export const gitMutationResponseSchema = z.object({
  ok: z.literal(true),
  /** The new commit when the operation created one. */
  sha: z.string().optional(),
});
export type GitMutationResponse = z.infer<typeof gitMutationResponseSchema>;

/** `GET .../index-file?path=…` — a repository path as staged in the index. */
export const indexFileResponseSchema = z.object({
  path: z.string(),
  content: z.string().nullable(),
  binary: z.boolean(),
  exists: z.boolean(),
});
export type IndexFileResponse = z.infer<typeof indexFileResponseSchema>;

/**
 * `GET .../git-original?path=…` — the owning repository's current HEAD
 * baseline for an ordinary editor file. A missing repository, ignored file,
 * unborn HEAD, or untracked file is represented explicitly rather than as a
 * 404 so the editor can decide whether to decorate it.
 */
export const gitOriginalResponseSchema = z.object({
  path: z.string(),
  repository: z.string().nullable(),
  repository_path: z.string().nullable(),
  head: z.string().nullable(),
  content: z.string().nullable(),
  binary: z.boolean(),
  exists: z.boolean(),
  tracked: z.boolean(),
  ignored: z.boolean(),
});
export type GitOriginalResponse = z.infer<typeof gitOriginalResponseSchema>;

/** `GET /api/worktrees/:sid/file-at?ref=…&path=…` — a file's content at a ref. */
export const fileAtResponseSchema = z.object({
  path: z.string(),
  ref: z.string(),
  content: z.string().nullable(),
  binary: z.boolean(),
});
export type FileAtResponse = z.infer<typeof fileAtResponseSchema>;

export const commitSummarySchema = z.object({
  sha: z.string(),
  subject: z.string(),
  author_name: z.string(),
  author_email: z.string(),
  authored_at: isoTimestamp,
  /**
   * Parent shas, oldest-listed-first as git reports them. Optional: older
   * daemons omit it and the history list renders without a graph. Drives the
   * commit-graph lane layout in the unified Changes navigator (SPEC §8).
   */
  parents: z.array(z.string()).optional(),
});
export type CommitSummary = z.infer<typeof commitSummarySchema>;

/** `GET /api/worktrees/:sid/log?limit=…&skip=…` — paginated commit history. */
export const logResponseSchema = z.object({
  commits: z.array(commitSummarySchema),
  has_more: z.boolean(),
});
export type LogResponse = z.infer<typeof logResponseSchema>;

/** `GET /api/worktrees/:sid/show/:sha` — a single commit's message and file changes. */
export const showCommitResponseSchema = z.object({
  commit: commitSummarySchema.extend({ body: z.string() }),
  parents: z.array(z.string()),
  files: z.array(diffEntrySchema),
});
export type ShowCommitResponse = z.infer<typeof showCommitResponseSchema>;
