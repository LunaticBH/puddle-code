import { describe, expect, it } from 'vitest';
import { CLIENT_PLATFORM, clientPlatformOf } from '../../src/lib/client-platform';

describe('clientPlatformOf', () => {
  it('reads navigator.platform the way browsers and Electron report it', () => {
    expect(clientPlatformOf('MacIntel')).toBe('mac');
    expect(clientPlatformOf('iPhone')).toBe('mac');
    expect(clientPlatformOf('iPad')).toBe('mac');
    expect(clientPlatformOf('Win32')).toBe('windows');
    expect(clientPlatformOf('Linux x86_64')).toBe('other');
    expect(clientPlatformOf('')).toBe('other');
  });

  it('is the historical Mac outside a browser, whatever machine runs the tests', () => {
    expect(CLIENT_PLATFORM).toBe('mac');
  });
});
