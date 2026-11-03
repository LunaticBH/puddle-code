import { z } from 'zod';
import { compilationFileTargetSchema } from '../compilation.js';

const id = z.string().min(1).max(128);
const json = z.record(z.string(), z.unknown());
const binary = z
  .string()
  .max(2 * 1024 * 1024)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const notebookWidgetMessageSchema = z.object({
  msg_id: id,
  parent_id: z.string().max(128).default(''),
  msg_type: z.enum(['comm_open', 'comm_msg', 'comm_close', 'status']),
  content: json,
  metadata: json.default({}),
  buffers: z.array(binary).max(128).default([]),
});
export type NotebookWidgetMessage = z.infer<typeof notebookWidgetMessageSchema>;
export const notebookWidgetStateSchema = z.object({
  version_major: z.literal(2),
  version_minor: z.literal(0),
  state: z
    .record(
      id,
      z.object({
        model_name: z.string().max(256),
        model_module: z.string().max(256),
        model_module_version: z.string().max(128),
        state: json,
        buffers: z
          .array(
            z.object({
              encoding: z.literal('base64'),
              path: z.array(z.union([z.string().max(256), z.number().int().nonnegative()])).max(64),
              data: binary,
            }),
          )
          .max(128)
          .optional(),
      }),
    )
    .refine((state) => Object.keys(state).length <= 1024, 'Too many widget models'),
});
export type NotebookWidgetState = z.infer<typeof notebookWidgetStateSchema>;
export const notebookWidgetsRequestSchema = z.object({
  source: compilationFileTargetSchema,
  generation: z.string().uuid().optional(),
  after: z.number().int().nonnegative().optional(),
});
export type NotebookWidgetsRequest = z.infer<typeof notebookWidgetsRequestSchema>;
export const notebookWidgetsResponseSchema = z.object({
  generation: z.string().uuid().nullable(),
  revision: z.number().int().nonnegative(),
  snapshot: notebookWidgetStateSchema.optional(),
  events: z.array(notebookWidgetMessageSchema).max(256),
  error: z.string().max(1024).optional(),
});
export type NotebookWidgetsResponse = z.infer<typeof notebookWidgetsResponseSchema>;
export const notebookWidgetCommSchema = z.object({
  source: compilationFileTargetSchema,
  generation: z.string().uuid(),
  message: notebookWidgetMessageSchema.extend({
    msg_type: z.enum(['comm_open', 'comm_msg', 'comm_close']),
    content: z.object({
      comm_id: id,
      target_name: z.literal('jupyter.widget').optional(),
      data: json,
    }),
  }),
});
export type NotebookWidgetComm = z.infer<typeof notebookWidgetCommSchema>;
