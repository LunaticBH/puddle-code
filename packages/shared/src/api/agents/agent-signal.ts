import { z } from 'zod';

/**
 * POST /agent-signal (SPEC §4/§6) — the agent-hook status side-channel.
 * Deliberately OUTSIDE /api: the caller is a hook process the agent spawned on
 * the daemon's own host (e.g. Claude Code's Stop/Notification hooks), which
 * has no bearer token. It authenticates with the per-session `nonce` the
 * daemon injected into the agent PTY's environment at spawn — single-purpose,
 * unguessable, dead once the session's PTY exits. `state` maps to the session
 * status: `working` → running, `waiting_input` → waiting_input.
 */
const statusSignalSchema = z.object({
  nonce: z.string().min(16),
  state: z.enum(['working', 'waiting_input']),
});

/** Exact top-level native lifecycle transition reported by an adapter hook. */
export const agentLifecycleSignalSchema = z.object({
  nonce: z.string().min(16),
  event: z.enum(['session_start', 'session_end']),
  /** Agent-native conversation id. Required for a start; optional on a best-effort end hook. */
  agent_session_ref: z.string().min(1).optional(),
  cwd: z.string().min(1),
  source: z.enum(['startup', 'resume', 'clear', 'fork', 'compact', 'exit', 'other']),
  parent_agent_session_ref: z.string().min(1).optional(),
  native_title: z.string().optional(),
  native_created_at: z.iso.datetime({ offset: true }).optional(),
  native_updated_at: z.iso.datetime({ offset: true }).optional(),
});

/** A bounded top-level turn observed by an adapter's native hook/plugin. */
export const agentTurnSignalSchema = z.object({
  nonce: z.string().min(16).max(200),
  event: z.enum(['turn_start', 'turn_complete', 'turn_failed']),
  agent_session_ref: z.string().min(1).max(200),
  turn_id: z.string().min(1).max(200),
  prompt_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  reply: z
    .string()
    .max(256 * 1024)
    .refine((value) => new TextEncoder().encode(value).length <= 256 * 1024)
    .optional(),
  error: z.string().max(4096).optional(),
});
export type AgentTurnSignal = z.infer<typeof agentTurnSignalSchema>;
export const agentSignalRequestSchema = z.union([
  statusSignalSchema,
  agentLifecycleSignalSchema,
  agentTurnSignalSchema,
]);
export type AgentSignalRequest = z.infer<typeof agentSignalRequestSchema>;
