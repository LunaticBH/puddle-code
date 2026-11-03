import { hostParamStore } from '../navigation/editor-links';

/**
 * Whether this window reached the cockpit through an SSH tunnel — the
 * `?host=` boot param the CLI sends at connect time (Phase 6), captured by
 * `captureHostParam`. Null in local mode. Drives the SSH-only behaviours:
 * terminal localhost-URL rewriting to the tier-2 proxy and the ports strip's
 * mode-appropriate access paths (SPEC §7/§9).
 */
export function sshMode(): string | null {
  return hostParamStore.get();
}
