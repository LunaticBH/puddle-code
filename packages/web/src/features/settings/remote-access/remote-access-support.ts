import type { CockpitRemoteStatus } from '@puddle/shared';
import { hostStyleForPlatform } from '../../../lib/host-path';

/**
 * Whether this host cannot offer remote access at all, so Settings shows a
 * plain "not supported" state instead of setup controls. The cockpit's own
 * status decides (`availability: 'unsupported'`, protocol 25.7): it reports
 * Windows hosts, whose relay connector has no supervision in v1
 * (docs/windows.md). The host's platform is only the fallback while no status
 * is in hand (still loading, or the cockpit could not answer), so a Windows
 * host never flashes setup controls or a misleading error first.
 */
export function remoteAccessUnsupported(
  status: Pick<CockpitRemoteStatus, 'availability'> | undefined,
  hostPlatform: string | undefined,
): boolean {
  if (status !== undefined) return status.availability === 'unsupported';
  return hostStyleForPlatform(hostPlatform) === 'win32';
}
