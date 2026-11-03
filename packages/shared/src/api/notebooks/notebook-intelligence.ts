import { z } from 'zod';
import { compilationFileTargetSchema } from '../compilation.js';

export const notebookIntelligenceRequestSchema = z
  .object({
    source: compilationFileTargetSchema,
    kind: z.enum(['complete', 'inspect']),
    code: z.string().max(65536),
    /** Jupyter positions count Unicode codepoints, not UTF-16 units. */
    cursor: z.number().int().nonnegative().max(65536),
  })
  .refine((value) => value.cursor <= [...value.code].length, 'Cursor is outside the cell');
export type NotebookIntelligenceRequest = z.infer<typeof notebookIntelligenceRequestSchema>;
export const notebookIntelligenceResponseSchema = z.object({
  matches: z.array(z.string().max(512)).max(200),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  documentation: z.string().max(32768),
});
export type NotebookIntelligenceResponse = z.infer<typeof notebookIntelligenceResponseSchema>;
