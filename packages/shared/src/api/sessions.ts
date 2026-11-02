import { z } from 'zod';
import { isoTimestamp, projectId, rowId, sessionId } from './common.js';

export const sessionStatusSchema = z.enum([
  'starting',
  'running',
  'waiting_input',
  'exited',
  'interrupted',
  'archived',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/**
 * A session is either an `agent` (a coding agent driving the worktree) or a
 * `terminal` (a plain shell PTY, no agent and no account — SPEC §4). The kind
 * decides which columns are populated: `terminal` sessions have null
 * `account_id`/`agent_type` and never onboard, resume a conversation, or migrate.
 */
export const sessionKindSchema = z.enum(['agent', 'terminal']);
export type SessionKind = z.infer<typeof sessionKindSchema>;
export const agentModeSchema = z.enum(['interactive', 'headless']);

export const sessionSchema = z.object({
  id: sessionId,
  project_id: projectId,
  /** Null for terminal sessions, which have no account (SPEC §4). */
  account_id: rowId.nullable(),
  worktree_path: z.string(),
  base_branch: z.string(),
  branch: z.string(),
  /** False: the session works directly on the base branch in a shared worktree (SPEC §4). */
  separate_branch: z.boolean(),
  kind: sessionKindSchema,
  /** Null for terminal sessions, which run a plain shell rather than an agent. */
  agent_type: z.string().nullable(),
  /** Native TUI or structured CLI execution with a terminal transcript. */
  agent_mode: agentModeSchema.optional(),
  /** Live foreground agent in a terminal session; icon hint only, never persisted. */
  detected_agent_type: z.string().nullable().optional(),
  /** Runtime status is observed in memory and has not yet been saved. */
  persistence_pending: z.boolean().optional(),
  agent_session_ref: z.string().nullable(),
  /** Durable native-conversation catalogue row; null for terminal sessions. */
  conversation_id: rowId.nullable().optional(),
  /** Native parent conversation, when the agent records a fork relationship. */
  parent_conversation_id: rowId.nullable().optional(),
  /** User-set display override; null means "use the agent's own name" (agent_title) then the id. */
  title: z.string().nullable(),
  /**
   * The agent's own session name (for Claude Code, the transcript's ai-title /
   * agent-name — the name shown in its resume picker), maintained by the daemon.
   * The default display name when the user has not set a `title`. Optional:
   * older daemons omit it; null when the agent has not named the session yet.
   */
  agent_title: z.string().nullable().optional(),
  /** Two successful native scans could no longer find this conversation. */
  conversation_missing: z.boolean().optional(),
  /** This placement owns worktree/branch-dependent destructive actions. */
  branch_owner: z.boolean().optional(),
  /** Strength of exact in-agent lifecycle synchronisation for this runtime. */
  native_sync: z.enum(['pending', 'full', 'fallback']).optional(),
  /**
   * The terminal-title "sequence" name: the last title the process set on its
   * PTY via an OSC 0/1/2 escape, normalised (leading spinner/status glyphs
   * stripped). This is the VSCode `${sequence}` variable — a name source for
   * agents and terminals that have no adapter-maintained `agent_title`. Optional:
   * older daemons omit it; null when the process has set no title. It never
   * overrides a user `title`; see `tabTitleTemplate` for how it is composed.
   */
  osc_title: z.string().nullable().optional(),
  status: sessionStatusSchema,
  /**
   * A TERMINAL session's last prompt directory, relative to `worktree_path`;
   * null (or absent, on an older daemon) means the worktree root. Initially set
   * by "Open Terminal in Directory", then updated after `cd`, so a resume
   * returns to the same directory. Always null for agents.
   */
  cwd: z.string().nullable().optional(),
  skip_permissions: z.boolean(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  last_activity_at: isoTimestamp.nullable(),
  /** Computed on read: the worktree dir is gone; the session can only be archived. */
  worktree_missing: z.boolean().optional(),
  /**
   * Computed on read: the session says `running` but the agent's own
   * transcript has been quiet for over an hour — the agent process is likely
   * wedged (SPEC §4). Advisory only: the daemon never interrupts an agent on
   * the strength of it (a very long tool call looks identical), it just lets
   * the UI say "this may be stalled". Optional: older daemons omit it.
   */
  stale_running: z.boolean().optional(),
  /**
   * Ahead/behind counts vs. the base branch plus a dirty-file count. Optional:
   * older daemons omit it, and it is computed only on the single-session GET
   * (`GET /api/sessions/:id`) — never on the list endpoint, where it would be
   * too expensive to compute per row.
   */
  git_summary: z
    .object({
      ahead: z.number().int().nonnegative(),
      behind: z.number().int().nonnegative(),
      dirty_files: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});
export type Session = z.infer<typeof sessionSchema>;

export const createSessionRequestSchema = z.object({
  project_id: projectId,
  /**
   * Required for an `agent` session, forbidden for a `terminal` one (which has
   * no account). The daemon enforces the pairing against `kind`.
   */
  account_id: rowId.optional(),
  /**
   * Defaults to `agent`. A `terminal` session spawns a plain shell in the
   * worktree — no account, no agent, no onboarding — and defaults
   * `separate_branch` to false (SPEC §4).
   */
  kind: sessionKindSchema.optional(),
  base_branch: z.string().min(1).optional(),
  branch: z.string().min(1).max(200).optional(),
  /**
   * Default true for agents, false for terminals: work on a fresh branch (its
   * own new worktree). False: work directly on the base branch — `branch` must
   * then be absent (SPEC §4).
   */
  separate_branch: z.boolean().optional(),
  /**
   * Independent of `separate_branch`: whether this session gets its own working
   * directory (default true) or shares an existing one. Only meaningful — and
   * only allowed false — when `separate_branch` is false: a new branch always
   * gets its own worktree. False shares the base branch's directory (see
   * `join_session`), so concurrent agents work in the same files (SPEC §4).
   */
  separate_worktree: z.boolean().optional(),
  /**
   * When sharing a directory (`separate_worktree: false`), the path of an
   * existing git worktree of this repo to land in — any entry from
   * `GET /api/repos/:id/worktrees`, including the repo's own clone. The way to
   * drop a session into a directory another is already working in. Omit to use
   * (or create) the base branch's default directory: the clone itself when that
   * branch is checked out there, else the canonical shared worktree.
   */
  join_worktree: z.string().optional(),
  /**
   * Directory the shell starts in, RELATIVE to the session's worktree — the
   * file tree's "Open terminal in directory". `terminal` sessions only (an
   * agent is given its worktree and decides for itself); rejected otherwise.
   * Must stay inside the worktree, and is PERSISTED on the session: a resume
   * after a daemon restart brings the shell back to the same directory.
   */
  cwd: z.string().optional(),
  title: z.string().min(1).max(200).optional(),
  prompt: z.string().optional(),
  skip_permissions: z.boolean().optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

/**
 * Rename. An empty string clears the user override so the display name reverts
 * to the agent's own name (`agent_title`) and then the session-id prefix.
 */
export const patchSessionRequestSchema = z.object({ title: z.string().max(200) });

/**
 * `POST /api/sessions/:id/migrate` — tier-1 migration (SPEC §5, §6): move a
 * session to another account of the SAME (profile, agent) and resume it there.
 * The conversation itself does not move — it lives in the profile's shared
 * conversation store, reachable from every account (§S) — so migration is
 * "stop the process, repoint `account_id`, resume under the target's
 * credentials". Returns the updated session detail; `skip_permissions` is
 * re-evaluated for the target at resume time (§11.4).
 */
export const migrateSessionRequestSchema = z.object({ account_id: rowId });
export type MigrateSessionRequest = z.infer<typeof migrateSessionRequestSchema>;

/**
 * `POST /api/sessions/:id/handoff` — tier-2 cross-agent hand-off (SPEC §5, §6):
 * continue this session's work on an account running a DIFFERENT agent. No
 * shared conversation format exists, so nothing moves: a NEW session is created
 * in the same worktree and branch, seeded with a briefing built from the source
 * adapter's transcript plus the branch's commits and `git status`. The source
 * session is left exactly as it was, and the two are linked by events.
 *
 * Distinct from `/migrate` in outcome, not just in target — this returns a
 * different session from the one addressed in the path. Same-agent targets
 * belong on `/migrate` and are rejected here with `same_agent`.
 */
export const handoffSessionRequestSchema = z.object({ account_id: rowId });
export type HandoffSessionRequest = z.infer<typeof handoffSessionRequestSchema>;

/**
 * `GET /api/sessions/:id/env` — the session's captured environment (SPEC §4):
 * vars exported in its terminals, persisted for re-injection at PTY spawn.
 * `value` is optional for compatibility with daemons before protocol 16.2.
 */
export const sessionEnvVarSchema = z.object({
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  value: z.string().optional(),
});
export const sessionEnvResponseSchema = z.object({
  vars: z.array(sessionEnvVarSchema),
});
export type SessionEnvResponse = z.infer<typeof sessionEnvResponseSchema>;

/** `DELETE /api/sessions/:id/env` — drop every captured var (the manual purge). */
export const clearSessionEnvResponseSchema = z.object({
  cleared: z.number().int().nonnegative(),
});
export type ClearSessionEnvResponse = z.infer<typeof clearSessionEnvResponseSchema>;

/** Shared by session archive and project archive (kill/discard confirmation). */
export const archiveRequestSchema = z.object({
  force: z.boolean().default(false),
  /**
   * Also delete the session's git branch (`git branch -D` — unpushed work is
   * gone for good). Only valid for separate-branch sessions; project archive
   * never deletes branches (SPEC §4).
   */
  delete_branch: z.boolean().default(false),
});
