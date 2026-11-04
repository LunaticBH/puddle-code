import { describe, expect, it } from 'vitest';
import { remoteAccessUnsupported } from '../../src/features/settings/remote-access/remote-access-support';

describe('remoteAccessUnsupported', () => {
  it('follows the cockpit’s explicit status', () => {
    expect(remoteAccessUnsupported({ availability: 'unsupported' }, 'win32')).toBe(true);
    // The status wins over the platform both ways.
    expect(remoteAccessUnsupported({ availability: 'unsupported' }, 'linux')).toBe(true);
    expect(remoteAccessUnsupported({ availability: 'ready' }, 'win32')).toBe(false);
  });

  it('falls back to the host platform while no status is in hand', () => {
    expect(remoteAccessUnsupported(undefined, 'win32')).toBe(true);
    expect(remoteAccessUnsupported(undefined, 'linux')).toBe(false);
    expect(remoteAccessUnsupported(undefined, 'darwin')).toBe(false);
    // Pre-25.7 daemons report no platform; none of them runs on Windows.
    expect(remoteAccessUnsupported(undefined, undefined)).toBe(false);
  });

  it('keeps every POSIX status on its existing path', () => {
    for (const availability of ['ready', 'not_installed', 'upgrade_required'] as const) {
      for (const platform of ['linux', 'darwin', undefined]) {
        expect(remoteAccessUnsupported({ availability }, platform)).toBe(false);
      }
    }
  });
});
