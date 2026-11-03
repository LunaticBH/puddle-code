import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginComparison,
  comparedMtime,
  completeComparison,
  comparisonLocksBuffer,
  conflictFor,
  failComparison,
  finishOpeningComparison,
  registerConflict,
  clearAllConflicts,
  shouldOfferComparison,
  subscribeConflict,
} from '../../../src/features/editor/conflicts/conflict-store';

describe('stale-save conflict state', () => {
  beforeEach(clearAllConflicts);

  it('offers Compare only while an unresolved buffer is focused', () => {
    const conflict = registerConflict('file');
    expect(conflict.phase).toBe('unresolved');
    expect(shouldOfferComparison(conflict, true)).toBe(true);
    expect(shouldOfferComparison(conflict, false)).toBe(false);
    expect(comparisonLocksBuffer(conflict)).toBe(false);
  });

  it('locks before loading and unlocks only after the diff editor mounts', () => {
    registerConflict('file');
    const revision = beginComparison('file');
    expect(revision).not.toBeNull();
    expect(conflictFor('file')?.phase).toBe('loading');
    expect(comparisonLocksBuffer(conflictFor('file'))).toBe(true);

    expect(completeComparison('file', revision!, 'disk content', 42)).toBe(true);
    expect(conflictFor('file')?.phase).toBe('opening');
    expect(comparedMtime(conflictFor('file'))).toBeUndefined();
    expect(comparisonLocksBuffer(conflictFor('file'))).toBe(true);

    expect(finishOpeningComparison('file', revision!)).toBe(true);
    expect(conflictFor('file')?.phase).toBe('comparing');
    expect(comparedMtime(conflictFor('file'))).toBe(42);
    expect(comparisonLocksBuffer(conflictFor('file'))).toBe(false);
  });

  it('keeps a failed disk read locked and retryable', () => {
    registerConflict('file');
    const revision = beginComparison('file')!;
    expect(failComparison('file', revision, 'gone')).toBe(true);
    expect(conflictFor('file')).toEqual({ phase: 'load-error', revision, message: 'gone' });
    expect(comparisonLocksBuffer(conflictFor('file'))).toBe(true);
    expect(beginComparison('file')).toBe(revision);
    expect(conflictFor('file')?.phase).toBe('loading');
  });

  it('ignores a completion from a superseded comparison', () => {
    const first = registerConflict('file').revision;
    expect(beginComparison('file')).toBe(first);
    const second = registerConflict('file').revision;
    expect(second).not.toBe(first);
    expect(completeComparison('file', first, 'old disk', 1)).toBe(false);
    expect(conflictFor('file')).toEqual({ phase: 'unresolved', revision: second });
  });

  it('notifies subscribers for every transition', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeConflict('file', listener);
    registerConflict('file');
    beginComparison('file');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    failComparison('file', conflictFor('file')!.revision, 'nope');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
