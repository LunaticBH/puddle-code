import { describe, expect, it } from 'vitest';
import { windowsPtyOptions } from '../../src/features/terminal/windows-pty';

describe('windowsPtyOptions', () => {
  it('tells xterm a Windows host’s PTY is ConPTY', () => {
    expect(windowsPtyOptions('win32')).toEqual({ windowsPty: { backend: 'conpty' } });
  });

  it('passes the host’s Windows build so xterm can pick its ConPTY workarounds', () => {
    // Windows 10 22H2 (below xterm's 21376 reflow cut-off) and Windows 11 24H2.
    expect(windowsPtyOptions('win32', 19045)).toEqual({
      windowsPty: { backend: 'conpty', buildNumber: 19045 },
    });
    expect(windowsPtyOptions('win32', 26100)).toEqual({
      windowsPty: { backend: 'conpty', buildNumber: 26100 },
    });
  });

  it('adds no build key when the host reports none', () => {
    expect('buildNumber' in windowsPtyOptions('win32', undefined).windowsPty!).toBe(false);
  });

  it('adds no key at all for a POSIX host', () => {
    // xterm reads `windowsPty.backend` unguarded: an explicit undefined would throw.
    expect(windowsPtyOptions('posix')).toEqual({});
    expect('windowsPty' in windowsPtyOptions('posix')).toBe(false);
    expect(windowsPtyOptions('posix', 26100)).toEqual({});
  });
});
