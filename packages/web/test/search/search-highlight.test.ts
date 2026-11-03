/**
 * Pure-logic tests for the Search navigator's match highlighting (SPEC §8).
 */
import { describe, expect, it } from 'vitest';
import {
  buildMatcher,
  splitHighlight,
  trimPreview,
} from '../../src/features/search/search-highlight';

const opts = (over: Partial<Parameters<typeof buildMatcher>[0]>) => ({
  query: '',
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  ...over,
});

describe('buildMatcher', () => {
  it('escapes a fixed-string query so regex metacharacters are literal', () => {
    const m = buildMatcher(opts({ query: 'a.b(' }));
    expect(m).not.toBeNull();
    expect('a.b('.match(m!)).not.toBeNull();
    expect('axb('.match(m!)).toBeNull(); // '.' is literal, not "any char"
  });

  it('honours the case-sensitive flag', () => {
    expect('FOO'.match(buildMatcher(opts({ query: 'foo' }))!)).not.toBeNull();
    expect('FOO'.match(buildMatcher(opts({ query: 'foo', caseSensitive: true }))!)).toBeNull();
  });

  it('wraps whole-word queries in boundaries', () => {
    const m = buildMatcher(opts({ query: 'cat', wholeWord: true }));
    expect('a cat sat'.match(m!)).not.toBeNull();
    expect('category'.match(m!)).toBeNull();
  });

  it('passes a regex query through untouched', () => {
    const m = buildMatcher(opts({ query: 'a.b', regex: true }));
    expect('axb'.match(m!)).not.toBeNull();
  });

  it('returns null for an invalid regex rather than throwing', () => {
    expect(buildMatcher(opts({ query: '(', regex: true }))).toBeNull();
  });

  it('returns null for an empty query', () => {
    expect(buildMatcher(opts({ query: '' }))).toBeNull();
  });
});

describe('splitHighlight', () => {
  it('splits a line into alternating hit / non-hit segments', () => {
    const m = buildMatcher(opts({ query: 'auth' }));
    expect(splitHighlight('call authenticate here', m)).toEqual([
      { text: 'call ', hit: false },
      { text: 'auth', hit: true },
      { text: 'enticate here', hit: false },
    ]);
  });

  it('renders plain text when the matcher is null', () => {
    expect(splitHighlight('plain', null)).toEqual([{ text: 'plain', hit: false }]);
  });

  it('does not loop forever on a zero-width match', () => {
    const m = buildMatcher(opts({ query: 'x*', regex: true }));
    // 'x*' can match empty; splitHighlight must terminate.
    const segs = splitHighlight('axbx', m);
    expect(segs.map((s) => s.text).join('')).toBe('axbx');
  });
});

describe('trimPreview', () => {
  it('strips leading indentation', () => {
    expect(trimPreview('\t\t  const x = 1')).toBe('const x = 1');
  });

  it('caps very long lines with an ellipsis', () => {
    const long = 'a'.repeat(500);
    const out = trimPreview(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith('…')).toBe(true);
  });
});
