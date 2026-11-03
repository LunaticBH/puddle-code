/** Pure matching and keyboard-entry tests for in-view find (SPEC §7/§8). */
import { describe, expect, it } from 'vitest';
import { htmlPreviewFindBridgeScript } from '../../src/features/editor/previews/html/html-preview-find';
import { findMatches } from '../../src/features/find/find-matches';
import { isFindShortcut } from '../../src/features/find/find-shortcut';
import type { FindOptions } from '../../src/features/find/find-types';

const options = (over: Partial<FindOptions> = {}): FindOptions => ({
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  ...over,
});

describe('findMatches', () => {
  it('finds fixed strings case-insensitively by default', () => {
    expect(findMatches('Find find finder', 'find', options()).matches).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9 },
      { start: 10, end: 14 },
    ]);
  });

  it('honours case, whole-word, and regex options', () => {
    expect(
      findMatches('FOO foo food', 'foo', options({ caseSensitive: true, wholeWord: true })).matches,
    ).toEqual([{ start: 4, end: 7 }]);
    expect(findMatches('a1 a2', 'a\\d', options({ regex: true })).matches).toHaveLength(2);
  });

  it('reports invalid expressions and safely skips zero-width matches', () => {
    expect(findMatches('text', '[', options({ regex: true })).invalid).toBe(true);
    expect(findMatches('text', '^', options({ regex: true })).matches).toEqual([]);
  });

  it('caps pathological result sets', () => {
    const result = findMatches('aaaa', 'a', options(), 2);
    expect(result.matches).toHaveLength(2);
    expect(result.limited).toBe(true);
  });
});

describe('isFindShortcut', () => {
  const event = (over: Partial<KeyboardEvent> = {}) =>
    ({ key: 'f', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over }) as Pick<
      KeyboardEvent,
      'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
    >;

  it('uses Command+F on macOS without stealing Ctrl+F', () => {
    expect(isFindShortcut(event({ metaKey: true }), true)).toBe(true);
    expect(isFindShortcut(event({ ctrlKey: true }), true)).toBe(false);
  });

  it('uses Ctrl+F elsewhere and rejects extra modifiers', () => {
    expect(isFindShortcut(event({ ctrlKey: true }), false)).toBe(true);
    expect(isFindShortcut(event({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });
});

describe('HTML preview find bridge', () => {
  it('emits syntactically valid sandbox code', () => {
    expect(() => new Function(htmlPreviewFindBridgeScript('find-channel'))).not.toThrow();
  });
});
