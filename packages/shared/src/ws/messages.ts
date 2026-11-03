import { z } from 'zod';
import { agentNotificationSchema } from '../notifications.js';
import { sessionStatusSchema } from '../api/agents/sessions.js';

/** Terminal ids within a stream: the agent PTY or numbered shells. */
export const termId = z.string().regex(/^(agent|shell-[0-9]+)$/);

/**
 * The homescreen's project-less PTY stream: one shell in the daemon host's
 * home directory, for cloning repositories before they become projects
 * (SPEC §11). `spawn-shell` on this stream reuses the live shell when one
 * exists rather than spawning a second.
 */
export const HOME_STREAM = 'home';

const dims = {
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
};

/**
 * `session` addresses a PTY stream: a puddle session uuid, `login-<accountId>`
 * for account-login PTYs (which attach "like a session", SPEC §6), or `home`
 * (HOME_STREAM) for the homescreen shell.
 */
export const wsClientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('auth'),
    token: z.string().max(128),
    resource: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
  z.object({ t: z.literal('attach'), session: z.string(), term: termId, ...dims }),
  z.object({ t: z.literal('stdin'), session: z.string(), term: termId, data: z.string() }),
  z.object({ t: z.literal('resize'), session: z.string(), term: termId, ...dims }),
  z.object({ t: z.literal('detach'), session: z.string(), term: termId }),
  z.object({ t: z.literal('spawn-shell'), session: z.string() }),
  /** Terminate a shell PTY (never the agent term); viewers learn via `exit`. */
  z.object({ t: z.literal('kill-shell'), session: z.string(), term: termId }),
  z.object({ t: z.literal('subscribe-status') }),
  /**
   * The client's resolved terminal colours (14.1): the DAEMON answers agents'
   * OSC 10/11 dynamic-colour queries from the last pair any client reported —
   * an auto-theming agent (e.g. Claude Code) queries at spawn, usually before
   * a viewer has attached, so a viewer-side answer misses it and the agent
   * falls back to dark whatever the app's theme. Sent after auth on every
   * connect and again on theme switches.
   */
  z.object({
    t: z.literal('theme'),
    fg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    bg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

/** Server messages are validated before crossing the encrypted remote boundary. */
export const wsServerMessageSchema = z.discriminatedUnion('t', [
  agentNotificationSchema,
  z.object({ t: z.literal('authenticated') }),
  z.object({ t: z.literal('shell-spawned'), session: z.string(), term: z.string() }),
  z.object({ t: z.literal('replay'), session: z.string(), term: z.string(), data: z.string() }),
  z.object({ t: z.literal('output'), session: z.string(), term: z.string(), data: z.string() }),
  z.object({
    t: z.literal('status'),
    session: z.string(),
    status: sessionStatusSchema,
    last_activity_at: z.string().nullable(),
  }),
  z.object({
    t: z.literal('renamed'),
    session: z.string(),
    title: z.string().nullable(),
    agent_title: z.string().nullable().optional(),
    osc_title: z.string().nullable().optional(),
  }),
  z.object({ t: z.literal('exit'), session: z.string(), term: z.string(), code: z.number() }),
  // Visible errors are broadcast to status subscribers, even if their terminal is elsewhere.
  z.object({
    t: z.literal('notice'),
    level: z.enum(['error', 'warning']),
    title: z.string(),
    detail: z.string().optional(),
    session: z.string().optional(),
    term: z.string().optional(),
  }),
  z.object({
    t: z.literal('account'),
    account_id: z.number(),
    profile_id: z.string(),
    logged_in: z.boolean(),
  }),
  z.object({
    t: z.literal('session-switched'),
    source_session: z.string(),
    target_session: z.string(),
    target_project: z.string(),
    cause: z.enum(['clear', 'resume', 'fork']),
    outcome: z.enum(['rebound', 'focused-existing']),
  }),
  z.object({ t: z.literal('sessions-changed'), project_ids: z.array(z.string()) }),
  z.object({ t: z.literal('error'), message: z.string() }),
]);
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;
