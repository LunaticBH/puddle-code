/**
 * Pure-logic tests for the history view (SPEC §8, Task 3.6d). The Monaco-
 * touching rendering (HistoryFileContent's read-only DiffEditor, CommitList,
 * CommitDetail) cannot run under vitest (see buffer-store.test.ts) and is
 * exercised manually; everything here is pure.
 */
import { describe, expect, it } from 'vitest';
import {
  bodyBeyondSubject,
  defaultFileExpanded,
  effectiveStatus,
  formatAbsolute,
  relativeTime,
} from '../../src/features/history/history-logic';

describe('relativeTime', () => {
  const now = new Date('2026-07-14T12:00:00Z');

  it('is "just now" under a minute', () => {
    expect(relativeTime('2026-07-14T12:00:00Z', now)).toBe('just now');
    expect(relativeTime('2026-07-14T11:59:31Z', now)).toBe('just now');
  });

  it('is minutes between 1 minute and 1 hour', () => {
    expect(relativeTime('2026-07-14T11:59:00Z', now)).toBe('1 m ago');
    expect(relativeTime('2026-07-14T11:55:00Z', now)).toBe('5 m ago');
    expect(relativeTime('2026-07-14T11:01:00Z', now)).toBe('59 m ago');
  });

  it('is hours between 1 hour and 1 day', () => {
    expect(relativeTime('2026-07-14T11:00:00Z', now)).toBe('1 h ago');
    expect(relativeTime('2026-07-14T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-07-13T13:00:00Z', now)).toBe('23 h ago');
  });

  it('is days between 1 day and 1 week', () => {
    expect(relativeTime('2026-07-13T12:00:00Z', now)).toBe('1 d ago');
    expect(relativeTime('2026-07-12T12:00:00Z', now)).toBe('2 d ago');
    expect(relativeTime('2026-07-08T00:00:00Z', now)).toBe('6 d ago');
  });

  it('falls back to a plain date at 1 week and beyond', () => {
    expect(relativeTime('2026-07-07T12:00:00Z', now)).toBe('7 Jul 2026');
    expect(relativeTime('2020-01-01T00:00:00Z', now)).toBe('1 Jan 2020');
  });

  it('clamps a future timestamp (clock skew) to "just now" rather than going negative', () => {
    expect(relativeTime('2026-07-14T12:05:00Z', now)).toBe('just now');
  });

  it('defaults `now` to the current time when omitted', () => {
    expect(relativeTime(new Date().toISOString())).toBe('just now');
  });
});

describe('formatAbsolute', () => {
  it('renders a full UTC date and time', () => {
    expect(formatAbsolute('2026-07-14T09:05:00Z')).toBe('14 Jul 2026, 09:05');
  });
});

describe('bodyBeyondSubject', () => {
  it('strips the subject line and blank separator, leaving only further body text', () => {
    expect(bodyBeyondSubject('Fix the bug\n\nThis fixes it by doing the thing.\n')).toBe(
      'This fixes it by doing the thing.',
    );
  });

  it('is empty for a subject-only commit message', () => {
    expect(bodyBeyondSubject('Fix the bug\n')).toBe('');
    expect(bodyBeyondSubject('Fix the bug')).toBe('');
  });

  it('collapses multiple blank separator lines', () => {
    expect(bodyBeyondSubject('Subject\n\n\nBody text\n')).toBe('Body text');
  });

  it('preserves multi-paragraph body text and trims only trailing whitespace', () => {
    expect(bodyBeyondSubject('Subject\n\nFirst paragraph.\n\nSecond paragraph.\n\n')).toBe(
      'First paragraph.\n\nSecond paragraph.',
    );
  });
});

describe('effectiveStatus', () => {
  it('passes the reported status through for a non-root commit', () => {
    expect(effectiveStatus('modified', false)).toBe('modified');
    expect(effectiveStatus('deleted', false)).toBe('deleted');
    expect(effectiveStatus('renamed', false)).toBe('renamed');
    expect(effectiveStatus('added', false)).toBe('added');
  });

  it('overrides every status to "added" for the root commit', () => {
    expect(effectiveStatus('modified', true)).toBe('added');
    expect(effectiveStatus('deleted', true)).toBe('added');
    expect(effectiveStatus('renamed', true)).toBe('added');
    expect(effectiveStatus('added', true)).toBe('added');
  });
});

describe('defaultFileExpanded', () => {
  it('expands by default at or below the limit', () => {
    expect(defaultFileExpanded(1)).toBe(true);
    expect(defaultFileExpanded(3)).toBe(true);
  });

  it('collapses by default beyond the limit', () => {
    expect(defaultFileExpanded(4)).toBe(false);
    expect(defaultFileExpanded(50)).toBe(false);
  });
});
