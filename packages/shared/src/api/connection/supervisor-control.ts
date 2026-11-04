import { z } from 'zod';
import { ipcChallengeSchema } from './connection-auth.js';

/**
 * The Windows supervisor's private control pipe, `ipcPath(home,
 * 'supervisor')` (protocol 25.7, docs/windows.md decision 6). The resident
 * supervisor runs the daemon and, while remote access is supervised, the
 * connector. Each connection carries one request with a fresh `challenge`,
 * and the answer's `proof` is `ipcProof(home, 'supervisor', challenge)`: a
 * pipe's name protects nothing on Windows, so clients believe only a proven
 * answer. `reconcile` re-reads whether the connector is supervised,
 * `restart_connector` replaces a running connector (after an upgrade) and
 * `shutdown` stops the daemon and connector before the supervisor exits.
 */
export const supervisorRequestSchema = z
  .object({
    t: z.enum(['status', 'reconcile', 'restart_connector', 'shutdown']),
    challenge: ipcChallengeSchema,
  })
  .strict();
export type SupervisorRequest = z.infer<typeof supervisorRequestSchema>;

const pidSchema = z.number().int().positive();
export const supervisorResponseSchema = z
  .object({
    t: z.literal('supervisor'),
    proof: z.string().regex(/^[a-f0-9]{64}$/),
    pid: pidSchema,
    /** The daemon child, while one runs. */
    daemon: pidSchema.nullable(),
    /** The connector child, while one runs. */
    connector: pidSchema.nullable(),
    /** True once `shutdown` was accepted: the supervisor starts nothing more. */
    stopping: z.boolean(),
  })
  .strict();
export type SupervisorResponse = z.infer<typeof supervisorResponseSchema>;
