import { z } from 'zod';
import { puddlangStartSchema } from './puddlang.js';

export const puddlangMcpRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export const puddlangMcpCallSchema = z.object({
  name: z.string(),
  arguments: z.unknown().optional(),
});
export const puddlangMcpRunSchema = puddlangStartSchema;
export const puddlangMcpIdSchema = z.object({ id: z.uuid() });
export const puddlangMcpEventsSchema = puddlangMcpIdSchema.extend({
  after: z.number().int().nonnegative().default(0),
});
export const puddlangMcpEmptySchema = z.object({}).strict();
const definitions = [
  [
    'puddlang_context',
    'List this host profile, projects, accounts and supported agents.',
    puddlangMcpEmptySchema,
    true,
  ],
  [
    'puddlang_run',
    'Execute a trusted single-file TypeScript programme on the host. Imports: puddlang (spawn, attach, input, z), zod, node: built-ins. Returns immediately with a durable run id; use status/events. Supply a fresh UUID id, or reuse it with identical input to recover an uncertain submission. spawn({agent:"codex",project:"name",account:"label"}); await agent.ask("task"); export default result. Supports structured ask({prompt,input,schema:z.object(...)}) and agent.stop().',
    puddlangMcpRunSchema,
    false,
  ],
  [
    'puddlang_status',
    'Read a run and its final default export, if finished.',
    puddlangMcpIdSchema,
    true,
  ],
  [
    'puddlang_events',
    'Read up to 100 events after a sequence; paginate until empty.',
    puddlangMcpEventsSchema,
    true,
  ],
  [
    'puddlang_cancel',
    'Cancel a run, interrupt its pending asks, and stop agents it created. Attached agents are retained.',
    puddlangMcpIdSchema,
    false,
  ],
] as const;
export const puddlangMcpTools = definitions.map(([name, description, schema, readOnlyHint]) => ({
  name,
  description,
  inputSchema: z.toJSONSchema(schema, { io: 'input' }),
  annotations: {
    readOnlyHint,
    destructiveHint: !readOnlyHint,
    idempotentHint: true,
    openWorldHint: !readOnlyHint,
  },
}));
