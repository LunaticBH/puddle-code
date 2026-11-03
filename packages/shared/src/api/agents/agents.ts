import { z } from 'zod';

/**
 * GET /api/agents: the daemon's registered agent adapters, with the
 * capabilities the UI needs for gating (e.g. hiding skip toggles for
 * adapters that cannot skip permission prompts).
 */
export const agentTypeSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  capabilities: z.object({
    resume: z.boolean(),
    skip_permissions: z.boolean(),
  }),
  /**
   * The executable the adapter spawns, e.g. 'claude'. Optional: older daemons
   * omit it. Sent so the UI can name it when it is missing without hard-coding
   * agent ids in the web package.
   */
  binary: z.string().optional(),
  /**
   * Whether that executable currently resolves on the daemon's PATH. False
   * means every account of this agent can only fail: adding one, logging in,
   * and starting a session are all rejected with `agent_not_installed`.
   * Optional: older daemons omit it, and the UI then assumes available.
   */
  available: z.boolean().optional(),
});
export type AgentType = z.infer<typeof agentTypeSchema>;
