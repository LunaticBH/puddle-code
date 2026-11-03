import { z } from 'zod';

/** Cockpit-local controls are authenticated independently of the daemon. */
export const cockpitRefreshRequestSchema = z.object({ refreshId: z.string().uuid() }).strict();
export const cockpitRefreshResponseSchema = z.object({
  status: z.literal('refreshing'),
  refreshId: z.string().uuid(),
  instance: z.string().uuid(),
});
export type CockpitRefreshResponse = z.infer<typeof cockpitRefreshResponseSchema>;

/** Client-machine file manager, advertised only by a local-host cockpit. */
export const cockpitFileManagerSchema = z.object({
  name: z.enum(['Finder', 'File Explorer', 'File Manager']).nullable(),
});
export type CockpitFileManager = z.infer<typeof cockpitFileManagerSchema>;

export const cockpitRevealRequestSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((path) => !path.includes('\0')),
  })
  .strict();
export type CockpitRevealRequest = z.infer<typeof cockpitRevealRequestSchema>;
