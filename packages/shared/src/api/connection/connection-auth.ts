import { z } from 'zod';
import { profileId } from '../common.js';
import { versionResponseSchema } from './version.js';

export const CONNECTION_POLICY = {
  participationMs: 15_000,
  leaseMs: 45_000,
  tokenMs: 60_000,
  rotationMs: 30_000,
  invitationMs: 300_000,
  browserIdleMs: 30 * 24 * 60 * 60 * 1000,
} as const;
export const CONTROL_MAX_BYTES = 256 * 1024;
export const resourceIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const connectionTokenSchema = z.string().regex(/^cn_[a-f0-9]{64}$/);
export const browserCredentialSchema = z.string().regex(/^br_[a-f0-9]{64}$/);
export const invitationSchema = z.string().regex(/^iv_[a-f0-9]{64}$/);
export const authErrorCodeSchema = z.enum([
  'browser_rejected',
  'upstream_expired',
  'upstream_unavailable',
  'protocol_mismatch',
]);
export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;
export const controlRequestSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('open'), profile: profileId.optional() }).strict(),
  z.object({ t: z.literal('renew'), resources: z.array(resourceIdSchema).max(2048) }).strict(),
  z.object({ t: z.literal('close') }).strict(),
  /**
   * Graceful daemon stop over the private control channel (protocol 25.7),
   * used by Windows supervision, which has no service manager to signal.
   * Older daemons answer `invalid_control`.
   */
  z.object({ t: z.literal('shutdown') }).strict(),
]);
export const hostInspectionSchema = z.object({
  t: z.literal('inspection'),
  port: z.number().int().min(1).max(65535),
  version: versionResponseSchema,
  liveSessions: z.number().int().nonnegative(),
});
export const controlResponseSchema = z.discriminatedUnion('t', [
  z
    .object({
      t: z.literal('authority'),
      generation: z.string().uuid(),
      token: connectionTokenSchema.optional(),
      validForMs: z.number().int().positive().max(45_000),
      port: z.number().int().min(1).max(65535),
      version: versionResponseSchema,
    })
    .strict(),
  hostInspectionSchema,
  /** Acknowledges `shutdown`: the daemon stops once its state is closed (25.7). */
  z.object({ t: z.literal('shutting_down') }).strict(),
  z
    .object({ t: z.literal('error'), code: z.enum(['unavailable', 'rejected', 'invalid_control']) })
    .strict(),
]);
export type ControlRequest = z.infer<typeof controlRequestSchema>;
export type ControlResponse = z.infer<typeof controlResponseSchema>;
export type HostInspection = z.infer<typeof hostInspectionSchema>;

export const browserBootstrapSchema = z.object({ invitation: invitationSchema }).strict();
export const browserBootstrapResponseSchema = z.object({ credential: browserCredentialSchema });
export const browserLogoutResponseSchema = z.object({ status: z.literal('revoked') });
export const proxyTargetSchema = z.object({
  session: z.string().uuid(),
  port: z.number().int().min(1).max(65535),
});
export const proxyGrantRequestSchema = proxyTargetSchema.extend({
  path: z.string().max(8192).default('/'),
});
export const proxyGrantResponseSchema = z.object({ url: z.string().url() });
export const proxyExchangeSchema = z.object({ invitation: invitationSchema }).strict();
export const launcherRequestSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('invite'), secret: z.string().max(128).optional() }).strict(),
  /**
   * Stop the cockpit cleanly (protocol 25.7): Windows has no SIGTERM to send
   * another process, so `puddle kill`/`refresh` ask over the launcher pipe.
   */
  z.object({ t: z.literal('shutdown'), secret: z.string().max(128).optional() }).strict(),
]);
export const launcherResponseSchema = z.object({ url: z.string().url() }).strict();
/** Acknowledges a launcher `shutdown`; the cockpit then closes (25.7). */
export const launcherShutdownResponseSchema = z.object({ t: z.literal('stopping') }).strict();
export const cockpitStatusSchema = z.object({
  instance: z.string().uuid(),
  refreshId: z.string().uuid().nullable(),
  upstream: z.enum(['ready', 'upstream_expired', 'upstream_unavailable', 'protocol_mismatch']),
});

/** Private cockpit storage: verifiers only, scoped to one target and origin. */
export const browserRecordSchema = z.object({
  id: z.string(),
  hash: z.string(),
  lastUsed: z.number(),
});
export const proxyRecordSchema = z.object({
  hash: z.string(),
  browser: z.string(),
  prefix: z.string(),
});
export const browserAuthorityStateSchema = z.object({
  version: z.literal(1),
  origin: z.string(),
  target: z.string(),
  browsers: z.array(browserRecordSchema),
  proxies: z.array(proxyRecordSchema),
});
export type BrowserRecord = z.infer<typeof browserRecordSchema>;
export type ProxyRecord = z.infer<typeof proxyRecordSchema>;
