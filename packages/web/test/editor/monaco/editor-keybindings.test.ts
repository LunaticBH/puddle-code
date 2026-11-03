import { describe, expect, it } from 'vitest';
import { nextWordWrap } from '../../../src/features/editor/monaco/editor-keybindings-logic';

describe('nextWordWrap', () => {
  it('flips the word-wrap setting (the ⌥Z toggle)', () => {
    expect(nextWordWrap(false)).toBe(true);
    expect(nextWordWrap(true)).toBe(false);
  });
});
