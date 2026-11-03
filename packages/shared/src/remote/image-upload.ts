import { z } from 'zod';
import { pasteImageMimeSchema } from '../api/worktrees/worktrees.js';

/** Image uploads keep each request well below the ordinary 256 KiB envelope. */
export const IMAGE_UPLOAD_POLICY = {
  imageBytes: 4 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  idleMs: 60_000,
  lifetimeMs: 5 * 60_000,
} as const;

/** Connector-local POST /api/worktrees/:sid/paste-upload; never forwarded verbatim. */
export const imageUploadRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      upload: z.string().uuid(),
      mime: pasteImageMimeSchema,
      size: z.number().int().positive().max(IMAGE_UPLOAD_POLICY.imageBytes),
    })
    .strict(),
  z
    .object({
      action: z.literal('chunk'),
      upload: z.string().uuid(),
      offset: z.number().int().nonnegative().max(IMAGE_UPLOAD_POLICY.imageBytes),
      data: z
        .string()
        .min(4)
        .max(4 * Math.ceil(IMAGE_UPLOAD_POLICY.chunkBytes / 3))
        .regex(/^[A-Za-z0-9+/]+={0,2}$/)
        .refine((data) => {
          const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
          return (
            data.length % 4 === 0 &&
            (data.length / 4) * 3 - padding <= IMAGE_UPLOAD_POLICY.chunkBytes
          );
        }, 'Image chunk is too large or malformed'),
    })
    .strict(),
  z.object({ action: z.literal('finish'), upload: z.string().uuid() }).strict(),
  z.object({ action: z.literal('cancel'), upload: z.string().uuid() }).strict(),
]);
export type ImageUploadRequest = z.infer<typeof imageUploadRequestSchema>;

export const imageUploadProgressSchema = z.object({
  received: z.number().int().nonnegative().max(IMAGE_UPLOAD_POLICY.imageBytes),
});
export type ImageUploadProgress = z.infer<typeof imageUploadProgressSchema>;
