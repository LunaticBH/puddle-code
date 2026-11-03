import { describe, expect, it } from 'vitest';
import { ADJECTIVES, ELEMENTS, NOUNS, memorableName } from '../../src/worktrees/names.js';
import { promptSlug, slugify } from '../../src/worktrees/slug.js';

describe('branch naming', () => {
  it('slugifies titles branch-safely', () => {
    expect(slugify('Fix flaky auth test!')).toBe('fix-flaky-auth-test');
  });

  it('cuts prompt slugs at a word boundary', () => {
    expect(promptSlug('fix the flaky auth test in the CI pipeline please')).toBe(
      'fix-the-flaky-auth-test-in',
    );
    expect(promptSlug('short task')).toBe('short-task');
    expect(promptSlug(null)).toBe('');
  });

  it('falls back to a memorable adjective-noun-element triple, never a uuid fragment', () => {
    for (let i = 0; i < 50; i++) {
      expect(memorableName()).toMatch(/^[a-z]+-[a-z]+-(earth|air|fire|water|metal|wood)$/);
    }
  });

  it('draws from 100 adjectives and 100 nouns, all branch-safe and distinct', () => {
    expect(ADJECTIVES).toHaveLength(100);
    expect(NOUNS).toHaveLength(100);
    for (const word of [...ADJECTIVES, ...NOUNS, ...ELEMENTS]) {
      expect(word).toMatch(/^[a-z]+$/);
    }
    expect(new Set(ADJECTIVES).size).toBe(ADJECTIVES.length);
    expect(new Set(NOUNS).size).toBe(NOUNS.length);
  });

  it('keeps the elements out of the nouns, even as substrings', () => {
    for (const noun of NOUNS) {
      for (const element of ELEMENTS) {
        expect(noun).not.toContain(element);
      }
    }
  });
});
