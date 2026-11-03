import { describe, expect, it } from 'vitest';
import {
  isCopyShortcut,
  type CopyKeyEvent,
} from '../../../src/features/terminal/clipboard/copy-shortcut';

const key = (over: Partial<CopyKeyEvent>): CopyKeyEvent => ({
  type: 'keydown',
  key: 'c',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe('isCopyShortcut', () => {
  it('is ⌘C on Mac — and plain Ctrl-C stays the interrupt', () => {
    expect(isCopyShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isCopyShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isCopyShortcut(key({ ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(isCopyShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isCopyShortcut(key({ metaKey: true, key: 'v' }), true)).toBe(false);
  });

  it('is Ctrl+Shift+C elsewhere — plain Ctrl-C stays the interrupt', () => {
    expect(isCopyShortcut(key({ ctrlKey: true, shiftKey: true, key: 'C' }), false)).toBe(true);
    expect(isCopyShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isCopyShortcut(key({ ctrlKey: true }), false)).toBe(false);
    expect(isCopyShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isCopyShortcut(key({ ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(false);
  });

  it('only fires on keydown', () => {
    expect(isCopyShortcut(key({ type: 'keyup', metaKey: true }), true)).toBe(false);
    expect(isCopyShortcut(key({ type: 'keypress', ctrlKey: true, shiftKey: true }), false)).toBe(
      false,
    );
  });
});
