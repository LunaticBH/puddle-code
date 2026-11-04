import { z } from 'zod';
import { profileId } from '../common.js';
import { connectorSetupSchema } from '../../remote/service.js';
import { ipcChallengeSchema } from './connection-auth.js';
import {
  remoteAdminRequestSchema,
  remoteDeviceSchema,
  remoteIdSchema,
  remoteOriginSchema,
  remotePeerSchema,
  remoteSecretSchema,
} from '../../remote/protocol.js';

/** Private host IPC only. Deletion is deliberately absent from remoteAdminRequestSchema. */
export const connectorLocalRequestSchema = z.union([
  remoteAdminRequestSchema,
  z.object({ t: z.literal('delete_registration') }).strict(),
]);
export type ConnectorLocalRequest = z.infer<typeof connectorLocalRequestSchema>;

/**
 * Windows only (protocol 25.7): the optional first line on a connector pipe
 * (`remote-<profile>` and the manager's `remote`), answered `proven` with
 * `ipcProof(home, <scope>, challenge)` before the one request it serves.
 * A pipe's name protects nothing on Windows, so the daemon's notifications
 * and the CLI's administrative requests go only to a server that proves it
 * can read the home. POSIX clients never send it.
 */
export const connectorChallengeSchema = z
  .object({ t: z.literal('challenge'), challenge: ipcChallengeSchema })
  .strict();
export const connectorProvenSchema = z
  .object({ t: z.literal('proven'), proof: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

/** Trusted local/SSH cockpit controls. Never admitted by the encrypted remote policy. */
export const cockpitRemoteRequestSchema = z.union([
  connectorLocalRequestSchema,
  z
    .object({
      t: z.literal('enable'),
      registration: z
        .object({ service: remoteOriginSchema, app: remoteOriginSchema, code: remoteSecretSchema })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ t: z.literal('reset') }).strict(),
]);
export type CockpitRemoteRequest = z.infer<typeof cockpitRemoteRequestSchema>;

/** Read-only machine-side check; neither consumes the code nor returns a routing credential. */
export const cockpitRegistrationCheckSchema = z
  .object({ service: remoteOriginSchema, code: remoteSecretSchema })
  .strict();

/**
 * Deliberately excludes routing credentials, account tokens and host private keys.
 * `unsupported` (protocol 25.7): the host's platform has no connector
 * supervision yet (Windows hosts, docs/windows.md).
 */
export const cockpitRemoteStatusSchema = z.object({
  availability: z.enum(['ready', 'not_installed', 'upgrade_required', 'unsupported']),
  configured: z.boolean(),
  enabled: z.boolean(),
  connected: z.boolean(),
  canDeleteRegistration: z.boolean().optional(),
  supervisor: z.enum(['systemd', 'launchd']).nullable(),
  host: remoteIdSchema.optional(),
  peer: remotePeerSchema.optional(),
  service: remoteOriginSchema.optional(),
  app: remoteOriginSchema.optional(),
  devices: z.array(remoteDeviceSchema),
});
export type CockpitRemoteStatus = z.infer<typeof cockpitRemoteStatusSchema>;

/** The profile is selected by the trusted local/SSH cockpit, never the remote browser. */
export const connectorProfileSchema = z.object({ profile: profileId }).strict();
export const connectorAdminSchema = z
  .object({ profile: profileId, request: connectorLocalRequestSchema })
  .strict();
export const connectorConfigureSchema = z
  .object({ profile: profileId, setup: connectorSetupSchema })
  .strict();
