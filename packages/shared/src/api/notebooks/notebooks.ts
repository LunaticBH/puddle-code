import { z } from 'zod';
import { compilationFileTargetSchema } from '../compilation.js';

export const notebookKernelSpecSchema = z.object({
  name: z.string().min(1),
  display_name: z.string().min(1),
  language: z.string(),
});
export type NotebookKernelSpec = z.infer<typeof notebookKernelSpecSchema>;
export const notebookKernelsResponseSchema = z.object({
  available: z.boolean(),
  kernels: z.array(notebookKernelSpecSchema),
  error: z.string().optional(),
});
export type NotebookKernelsResponse = z.infer<typeof notebookKernelsResponseSchema>;
export const notebookKernelRequestSchema = z.object({ source: compilationFileTargetSchema });
export type NotebookKernelRequest = z.infer<typeof notebookKernelRequestSchema>;
const pythonPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((path) => !path.includes('\0'));
export const notebookEnvironmentSchema = z.object({
  python: pythonPathSchema,
  label: z.string(),
  ipykernel: z.boolean(),
  nbconvert: z.boolean(),
  error: z.string().optional(),
});
export type NotebookEnvironment = z.infer<typeof notebookEnvironmentSchema>;
export const notebookEnvironmentsResponseSchema = z.object({
  environments: z.array(notebookEnvironmentSchema),
});
export type NotebookEnvironmentsResponse = z.infer<typeof notebookEnvironmentsResponseSchema>;
export const notebookKernelStatusSchema = z.object({
  state: z.enum(['stopped', 'starting', 'idle', 'busy', 'dead']),
  kernel: z.string().nullable(),
  error: z.string().optional(),
  environment: notebookEnvironmentSchema.optional(),
});
export type NotebookKernelStatus = z.infer<typeof notebookKernelStatusSchema>;
export const notebookKernelActionSchema = z.discriminatedUnion('action', [
  notebookKernelRequestSchema.extend({
    action: z.literal('select'),
    kernel: z.string().min(1).max(256),
  }),
  notebookKernelRequestSchema.extend({ action: z.enum(['interrupt', 'restart', 'shutdown']) }),
  notebookKernelRequestSchema.extend({
    action: z.literal('select-python'),
    python: pythonPathSchema,
  }),
  notebookKernelRequestSchema.extend({
    action: z.literal('install-python'),
    python: pythonPathSchema,
  }),
]);
export type NotebookKernelAction = z.infer<typeof notebookKernelActionSchema>;
