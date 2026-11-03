import { z } from 'zod';
import { isoTimestamp, profileId, rowId } from '../common.js';
import { fsSafeName } from '../profiles.js';

export const accountSchema = z.object({
  id: rowId,
  profile_id: profileId,
  agent_type: z.string(),
  label: z.string(),
  config_dir: z.string(),
  skip_permissions_default: z.boolean(),
  logged_in: z.boolean(),
  created_at: isoTimestamp,
});
export type Account = z.infer<typeof accountSchema>;

export const createAccountRequestSchema = z.object({
  profile_id: profileId,
  agent_type: z.string().min(1),
  label: fsSafeName,
  skip_permissions_default: z.boolean().optional(),
  /** Host path of a pre-existing agent config dir to COPY into the new
      account's puddle-owned dir (~ expands on the host). The source is
      never touched again. */
  import_dir: z.string().min(1).optional(),
});

/**
 * Account edits: the display `label` and the permissions-gate opt-in (SPEC
 * §11). Renaming changes only the label — the account's `config_dir` keeps its
 * original path so macOS keychain OAuth (bound to that path) is not broken.
 */
export const patchAccountRequestSchema = z.object({
  label: fsSafeName.optional(),
  skip_permissions_default: z.boolean().optional(),
});

/** Returned by POST /api/accounts/:id/login — attach to this PTY over the WS. */
export const loginResponseSchema = z.object({
  stream: z.string(),
  term: z.string(),
  /** Adapter guidance the login dialogue shows verbatim — e.g. how to leave a
      TUI that keeps running after sign-in (13.1, additive). */
  hint: z.string().optional(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/**
 * GET /api/accounts/:id/usage. Puddle-side counts are always present; the
 * agent-derived token totals are optional (only adapters that can read their
 * own history report them — token usage is not billing data). Loose so
 * adapters can add fields without a protocol break.
 */
export const accountUsageSchema = z.looseObject({
  account_id: rowId,
  logged_in: z.boolean(),
  session_count: z.number().int().nonnegative(),
  active_session_count: z.number().int().nonnegative(),
  last_activity_at: isoTimestamp.nullable(),
  agent_usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      cache_read_input_tokens: z.number().int().nonnegative(),
      cache_creation_input_tokens: z.number().int().nonnegative(),
      message_count: z.number().int().nonnegative(),
    })
    .nullable(),
  /** Live per-session signal (credential-free): context-window fill and cost. */
  live_usage: z
    .object({
      captured_at: isoTimestamp,
      context_used_percentage: z.number().nullable(),
      total_cost_usd: z.number().nullable(),
      model: z.string().nullable(),
    })
    .nullable(),
  /**
   * Subscription rate-limit windows, read from the agent's own CLI (e.g.
   * `claude -p /usage`) — credential-free, fetched for logged-in accounts. A
   * window carries a 0..100 percentage and the agent's own reset phrasing
   * ("Jul 20 at 4am"), shown verbatim; the whole field is null when the data
   * could not be fetched.
   */
  subscription: z
    .object({
      windows: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          used_percentage: z.number(),
          resets: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
});
export type AccountUsage = z.infer<typeof accountUsageSchema>;
