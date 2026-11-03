/**
 * `drafts.ts` persists to IndexedDB, which this repo's vitest environment
 * does not provide (`test: { name: 'web' }` runs under plain Node — verified
 * empirically: `typeof indexedDB === 'undefined'` here, and there is no
 * `fake-indexeddb` dependency to paper over it, per the task's "no new
 * dependencies" constraint). So this file covers exactly what IS testable
 * without a real IndexedDB:
 *   - `draftKey`, the one pure piece (record/key shaping never touches the
 *     database).
 *   - every exported async function resolving to its documented safe
 *     fallback (never throwing, never hanging) when `indexedDB` is absent —
 *     this is the behaviour a browser without IndexedDB (very old Safari,
 *     some private-browsing modes) would also see.
 *   - `draftWriter`'s debounce contract (flush/cancel/pending), which is
 *     independent of whether the underlying `saveDraft` succeeds.
 *
 * The actual save/load/delete/list round trip against a real IndexedDB is
 * NOT exercised here and remains a manual check (open the app, dirty an
 * editor buffer, reload the tab, confirm the draft restores — Task 7 wires
 * the restore UI this will actually exercise).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteDraft,
  deleteSessionDrafts,
  draftDisposition,
  draftKey,
  draftWriter,
  listDrafts,
  loadDraft,
  saveDraft,
} from '../../../src/lib/persistence/drafts';

describe('draftDisposition', () => {
  it('discards identical content even when only the disk mtime moved', () => {
    expect(draftDisposition({ content: 'same text', base_mtime_ms: 100 }, 'same text', 200)).toBe(
      'discard',
    );
  });

  it('restores changed content when the disk baseline is unchanged', () => {
    expect(draftDisposition({ content: 'draft', base_mtime_ms: 100 }, 'disk', 100)).toBe('restore');
  });

  it('offers changed content when the disk baseline moved', () => {
    expect(draftDisposition({ content: 'draft', base_mtime_ms: 100 }, 'disk', 200)).toBe('offer');
  });
});

describe('draftKey', () => {
  it('joins session and path with a delimiter', () => {
    expect(draftKey('sess-1', 'src/index.ts')).toBe('sess-1:src%2Findex.ts');
  });

  it('percent-encodes a literal delimiter so it cannot forge a collision', () => {
    // Without encoding, ('a:b', 'c') and ('a', 'b:c') would both stringify to "a:b:c".
    expect(draftKey('a:b', 'c')).not.toBe(draftKey('a', 'b:c'));
  });

  it('is stable for the same inputs', () => {
    expect(draftKey('s', 'p')).toBe(draftKey('s', 'p'));
  });
});

describe('drafts API without indexedDB', () => {
  beforeEach(() => {
    expect(typeof indexedDB).toBe('undefined'); // documents the assumption this suite relies on
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('saveDraft resolves without throwing', async () => {
    await expect(saveDraft('s', 'p', 'content', 1)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it('loadDraft resolves to null', async () => {
    await expect(loadDraft('s', 'p')).resolves.toBeNull();
  });

  it('deleteDraft resolves without throwing', async () => {
    await expect(deleteDraft('s', 'p')).resolves.toBeUndefined();
  });

  it('listDrafts resolves to an empty array', async () => {
    await expect(listDrafts('s')).resolves.toEqual([]);
  });

  it('deleteSessionDrafts resolves without throwing', async () => {
    await expect(deleteSessionDrafts('s')).resolves.toBeUndefined();
  });
});

describe('draftWriter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('debounces and reports pending until it fires', () => {
    const writer = draftWriter('s', 'p');
    expect(writer.pending()).toBe(false);
    writer('draft content', 123);
    expect(writer.pending()).toBe(true);
    vi.advanceTimersByTime(999);
    expect(writer.pending()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(writer.pending()).toBe(false);
  });

  it('flush runs the pending write immediately', () => {
    const writer = draftWriter('s', 'p');
    writer('draft content', 123);
    writer.flush();
    expect(writer.pending()).toBe(false);
  });

  it('cancel drops the pending write', () => {
    const writer = draftWriter('s', 'p');
    writer('draft content', 123);
    writer.cancel();
    expect(writer.pending()).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(writer.pending()).toBe(false);
  });
});
