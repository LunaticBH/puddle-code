import { describe, expect, it } from 'vitest';
import { windowsPtyOptions } from '../../src/features/terminal/windows-pty';

describe('windowsPtyOptions', () => {
  it('tells xterm a Windows host’s PTY is ConPTY', () => {
    expect(windowsPtyOptions('win32')).toEqual({ windowsPty: { backend: 'conpty' } });
  });

  it('adds no key at all for a POSIX host', () => {
    // xterm reads `windowsPty.backend` unguarded: an explicit undefined would throw.
    expect(windowsPtyOptions('posix')).toEqual({});
    expect('windowsPty' in windowsPtyOptions('posix')).toBe(false);
  });
});
