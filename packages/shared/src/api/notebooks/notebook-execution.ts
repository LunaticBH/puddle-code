import { z } from 'zod';
import { compilationFileTargetSchema } from '../compilation.js';

const cellId = z.string().min(1).max(128);
const cellSource = z.object({ id: cellId, source: z.string().max(1024 * 1024) });
export const notebookExecuteSchema = z
  .object({
    source: compilationFileTargetSchema,
    cells: z.array(cellSource).min(1).max(2000),
    kernel: z.string().min(1).max(256).optional(),
  })
  .refine(
    (request) => new Set(request.cells.map((cell) => cell.id)).size === request.cells.length,
    'Cell ids must be unique',
  )
  .refine(
    (request) =>
      request.cells.reduce((length, cell) => length + cell.source.length, 0) <= 1024 * 1024,
    'Cell sources exceed 1 MiB',
  );
export type NotebookExecute = z.infer<typeof notebookExecuteSchema>;
export const notebookExecutionCellSchema = cellSource.extend({
  revision: z.number().int().nonnegative().default(0),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  execution_count: z.number().int().nullable(),
  outputs: z.array(z.looseObject({ output_type: z.string() })),
  elapsed_ms: z.number().nonnegative().optional(),
});
export type NotebookExecutionCell = z.infer<typeof notebookExecutionCellSchema>;
export const notebookInputSchema = z.object({
  id: z.string().uuid(),
  prompt: z.string().max(4096),
  password: z.boolean(),
});
export const notebookExecutionSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  state: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  cells: z.array(notebookExecutionCellSchema).max(2000),
  input: notebookInputSchema.optional(),
  error: z.string().max(32768).optional(),
});
export type NotebookExecution = z.infer<typeof notebookExecutionSchema>;
export const notebookExecutionRequestSchema = z.object({ source: compilationFileTargetSchema });
export const notebookExecutionResponseSchema = z.object({
  execution: notebookExecutionSchema.nullable(),
});
export type NotebookExecutionResponse = z.infer<typeof notebookExecutionResponseSchema>;
export const notebookInputReplySchema = z.object({
  source: compilationFileTargetSchema,
  run_id: z.string().uuid(),
  input_id: z.string().uuid(),
  value: z.string().max(65536),
});
export type NotebookInputReply = z.infer<typeof notebookInputReplySchema>;
