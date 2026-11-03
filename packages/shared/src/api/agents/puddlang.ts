import { z } from 'zod';
import { profileId, sessionId } from '../common.js';
import { agentModeSchema } from './sessions.js';

export const PUDDLANG_MAX_SOURCE = 256 * 1024;
const sourceSchema = z
  .string()
  .min(1)
  .max(PUDDLANG_MAX_SOURCE)
  .refine(
    (source) => new TextEncoder().encode(source).length <= PUDDLANG_MAX_SOURCE,
    'Source exceeds 256 KiB',
  );
export const puddlangSpawnSchema = z
  .object({
    agent: z.string().min(1).max(100),
    mode: agentModeSchema.optional(),
    account: z.union([z.string().min(1).max(100), z.number().int().positive()]).optional(),
    project: z.string().min(1).max(200).optional(),
    worktree: z.string().min(1).max(4096).optional(),
    path: z.string().min(1).max(4096).optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .refine((v) => Boolean(v.path) !== Boolean(v.project), 'Choose path or project')
  .refine((v) => !v.path || !v.worktree, 'worktree requires project');
export type PuddlangSpawn = z.infer<typeof puddlangSpawnSchema>;

export const puddlangHandleSchema = z.object({ runtime_id: z.uuid(), session_id: sessionId });
export type PuddlangHandle = z.infer<typeof puddlangHandleSchema>;
export const puddlangAskSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(128 * 1024),
  output_schema: z.record(z.string(), z.unknown()).optional(),
});
export const puddlangStartSchema = z.object({
  id: z.uuid(),
  source: sourceSchema,
  input: z.unknown().optional(),
  accounts: z.record(z.string(), z.union([z.string(), z.number().int().positive()])).default({}),
  max_turns: z.number().int().min(1).max(1000).default(50),
  max_agents: z.number().int().min(1).max(32).default(8),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(24 * 60 * 60 * 1000)
    .default(60 * 60 * 1000),
});
export type PuddlangStart = z.infer<typeof puddlangStartSchema>;
export const puddlangRunSchema = z.object({
  id: z.uuid(),
  profile_id: profileId,
  source_hash: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PuddlangRun = z.infer<typeof puddlangRunSchema>;
export const puddlangEventSchema = z.object({
  sequence: z.number().int(),
  run_id: z.uuid(),
  type: z.string(),
  data: z.unknown(),
  created_at: z.string(),
});
export const puddlangEventsSchema = z.object({ events: z.array(puddlangEventSchema) });

/** Private runner IPC uses the same validated shapes as public operations. */
export const puddlangOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('spawn'), options: puddlangSpawnSchema }),
  z.object({ op: z.literal('attach'), reference: z.string().min(1).max(100) }),
  z.object({ op: z.literal('ask'), handle: puddlangHandleSchema, request: puddlangAskSchema }),
  z.object({ op: z.literal('stop'), handle: puddlangHandleSchema }),
]);
export type PuddlangOperation = z.infer<typeof puddlangOperationSchema>;
export const puddlangRunnerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('operation'),
    id: z.number().int(),
    operation: puddlangOperationSchema,
  }),
  z.object({
    type: z.literal('finished'),
    result: z.unknown().optional(),
    error: z.string().max(8192).optional(),
  }),
]);
export const puddlangRunnerInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    source: sourceSchema,
    input: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('reply'),
    id: z.number().int(),
    value: z.unknown().optional(),
    error: z.string().optional(),
  }),
]);
export const puddlangContextSchema = z.object({
  profile: z.object({ id: profileId, name: z.string() }),
  projects: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() })),
  accounts: z.array(
    z.object({ id: z.number(), label: z.string(), agent: z.string(), logged_in: z.boolean() }),
  ),
  agents: z.array(
    z.object({
      id: z.string(),
      /** Automated turn support in either mode; this is not a mode name. */
      scripted_turns: z.boolean(),
      modes: z.array(agentModeSchema).optional(),
    }),
  ),
});
