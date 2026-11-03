/**
 * Pure-logic tests for the diff view's status presentation (SPEC §8). The
 * Monaco-touching rendering in FileDiffSection cannot run under vitest (see
 * buffer-store.test.ts) and is exercised manually; everything here is pure.
 */
import { describe, expect, it } from 'vitest';
import type { DiffEntry } from '@puddle/shared';
import {
  DEFAULT_EXPANDED_LIMIT,
  defaultExpanded,
  diffStatusStyle,
  summariseCounts,
} from '../../src/features/diff/diff-status';

describe('diffStatusStyle', () => {
  it('maps each status to its glyph, label, and semantic colour utility', () => {
    expect(diffStatusStyle('added')).toEqual({
      letter: 'A',
      label: 'added',
      colourClass: 'text-success',
    });
    expect(diffStatusStyle('modified')).toEqual({
      letter: 'M',
      label: 'modified',
      colourClass: 'text-fg-secondary',
    });
    expect(diffStatusStyle('deleted')).toEqual({
      letter: 'D',
      label: 'deleted',
      colourClass: 'text-interrupted',
    });
    expect(diffStatusStyle('renamed')).toEqual({
      letter: 'R',
      label: 'renamed',
      colourClass: 'text-warning',
    });
  });
});

describe('summariseCounts', () => {
  const entry = (status: DiffEntry['status']): Pick<DiffEntry, 'status'> => ({ status });

  it('is empty for no entries', () => {
    expect(summariseCounts([])).toBe('');
  });

  it('counts a single status', () => {
    expect(summariseCounts([entry('modified'), entry('modified')])).toBe('2 modified');
  });

  it('orders modified · added · deleted · renamed and omits absent statuses', () => {
    const entries = [
      entry('renamed'),
      entry('added'),
      entry('modified'),
      entry('modified'),
      entry('modified'),
      entry('deleted'),
    ];
    expect(summariseCounts(entries)).toBe('3 modified · 1 added · 1 deleted · 1 renamed');
  });

  it('omits a status with no entries', () => {
    expect(summariseCounts([entry('added'), entry('deleted')])).toBe('1 added · 1 deleted');
  });
});

describe('defaultExpanded', () => {
  it('expands the first N sections and collapses the rest', () => {
    expect(defaultExpanded(0)).toBe(true);
    expect(defaultExpanded(DEFAULT_EXPANDED_LIMIT - 1)).toBe(true);
    expect(defaultExpanded(DEFAULT_EXPANDED_LIMIT)).toBe(false);
    expect(defaultExpanded(DEFAULT_EXPANDED_LIMIT + 10)).toBe(false);
  });

  it('honours a custom limit', () => {
    expect(defaultExpanded(1, 1)).toBe(false);
    expect(defaultExpanded(0, 1)).toBe(true);
  });
});
