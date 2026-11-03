import { z } from 'zod';

/**
 * Field validators without defaults. The patch schema must be built from
 * these: zod's `.partial()` on a defaulted field still fills the default,
 * so a patch schema derived from the defaulted object would silently reset
 * every field the patch omits.
 */
const fields = {
  port: z.number().int().min(1).max(65535),
  autoResume: z.boolean(),
  fetchIntervalMinutes: z.number().int().min(1),
  logMaxBytes: z
    .number()
    .int()
    .min(64 * 1024),
  /** Age of inactive bulk terminal output; zero disables age-based cleanup. */
  logRetentionDays: z.number().int().min(0).max(3650),
  replayBytes: z.number().int().min(1024),
  /** Days a (project, profile) ui_state row survives without an update. */
  uiStateRetentionDays: z.number().int().min(1),
  /**
   * Colon-separated dirs prepended to the daemon's PATH so it can find agent
   * CLIs even under a supervisor with a bare PATH (launchd/systemd). Leading `~`
   * expands to the daemon user's home. Covers Claude Code's native-installer
   * location (`~/.local/bin`). Takes effect on the next daemon start. A Windows
   * daemon separates entries with `;`, also expands `%VAR%`, and replaces this
   * POSIX default with its own (npm, pnpm, Bun and Scoop launcher dirs).
   */
  agentPath: z.string(),
  /**
   * User-chosen label for this host, shown across the UI in place of the OS
   * hostname when non-empty (surfaced via GET /api/host as `displayName`).
   * Purely cosmetic — never used for ssh commands or anything transport-level.
   */
  displayName: z.string().max(64),
};

/** Daemon-scope settings persisted in ~/.puddle/config.json. */
export const daemonConfigSchema = z.object({
  port: fields.port.default(7434),
  autoResume: fields.autoResume.default(true),
  fetchIntervalMinutes: fields.fetchIntervalMinutes.default(15),
  logMaxBytes: fields.logMaxBytes.default(10 * 1024 * 1024),
  logRetentionDays: fields.logRetentionDays.default(3),
  replayBytes: fields.replayBytes.default(256 * 1024),
  uiStateRetentionDays: fields.uiStateRetentionDays.default(90),
  agentPath: fields.agentPath.default('~/.local/bin:~/bin:/opt/homebrew/bin:/usr/local/bin'),
  displayName: fields.displayName.default(''),
});
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;

export const daemonConfigPatchSchema = z.object(fields).partial();
export type DaemonConfigPatch = z.infer<typeof daemonConfigPatchSchema>;
