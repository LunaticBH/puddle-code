import { describe, expect, it } from 'vitest';
import {
  monacoModifier,
  nextWordWrap,
} from '../../../src/features/editor/monaco/editor-keybindings-logic';

describe('nextWordWrap', () => {
  it('flips the word-wrap setting (the ⌥Z toggle)', () => {
    expect(nextWordWrap(false)).toBe(true);
    expect(nextWordWrap(true)).toBe(false);
  });
});

describe('monacoModifier', () => {
  it('keeps the historical mapping on Mac and Linux clients', () => {
    for (const client of ['mac', 'other'] as const) {
      expect(monacoModifier('meta', client)).toBe('CtrlCmd');
      expect(monacoModifier('ctrl', client)).toBe('WinCtrl');
      expect(monacoModifier('alt', client)).toBe('Alt');
      expect(monacoModifier('shift', client)).toBe('Shift');
    }
  });

  it('binds the key each modifier names on a Windows client', () => {
    // Windows defaults bind Ctrl (`shellDefaultBinding`): Monaco's CtrlCmd is Ctrl there.
    expect(monacoModifier('ctrl', 'windows')).toBe('CtrlCmd');
    expect(monacoModifier('meta', 'windows')).toBe('WinCtrl');
    expect(monacoModifier('alt', 'windows')).toBe('Alt');
  });

  it('ignores anything that is not a modifier', () => {
    expect(monacoModifier('KeyS', 'mac')).toBeNull();
  });
});
