import { z } from 'zod';

/**
 * GET /api/host: who and where the daemon is. The browser cannot tell a
 * local daemon from a tunnelled one (both arrive as 127.0.0.1), so the UI
 * shows this instead of anything derived from the origin — ports never
 * surface in the UI.
 */
export const hostInfoSchema = z.object({
  username: z.string(),
  hostname: z.string(),
  /** The daemon user's home directory, for ~-compressing displayed paths. */
  home: z.string(),
  /**
   * The user-chosen host label (config.json `displayName`), present when
   * non-empty. Display-only: the UI shows it wherever the host is named, but
   * ssh commands always use the real `hostname`.
   */
  displayName: z.string().optional(),
  /**
   * The daemon's `process.platform` (protocol 25.7), e.g. `win32`. Absent
   * means a POSIX host running an older daemon.
   */
  platform: z.string().optional(),
  /**
   * The Windows build number (the third part of `os.release()`), present on
   * Windows hosts (protocol 25.7). Terminals pass it to xterm so Windows 10
   * ConPTY gets its wrapping workarounds.
   */
  osBuild: z.number().int().nonnegative().optional(),
});
export type HostInfo = z.infer<typeof hostInfoSchema>;
