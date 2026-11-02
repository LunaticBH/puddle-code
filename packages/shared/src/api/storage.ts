import { z } from 'zod';

/** Local/SSH-only host storage diagnostics; paths can span multiple profiles. */
export const storageStatusSchema = z.object({
  checked_at: z.string().nullable(),
  volumes: z.array(
    z.object({
      path: z.string(),
      available_bytes: z.number().nonnegative().nullable(),
      available_inodes: z.number().nonnegative().nullable(),
      level: z.enum(['ok', 'warning', 'critical', 'unknown']),
    }),
  ),
  logs_degraded: z.boolean(),
  database_degraded: z.boolean(),
});
export type StorageStatus = z.infer<typeof storageStatusSchema>;
