import { describe, expect, it } from 'vitest';
import { parsePorcelainStatus, statusFromXY } from '../../src/worktrees/git-status.js';

describe('statusFromXY', () => {
  it('maps untracked and ignored', () => {
    expect(statusFromXY('?', '?')).toBe('untracked');
    expect(statusFromXY('!', '!')).toBe('ignored');
  });

  it('treats any unmerged pair as conflicted', () => {
    for (const [x, y] of [
      ['U', 'U'],
      ['A', 'A'],
      ['D', 'D'],
      ['A', 'U'],
      ['U', 'D'],
      ['D', 'U'],
    ] as const) {
      expect(statusFromXY(x, y)).toBe('conflicted');
    }
  });

  it('reads either column for added/modified/deleted', () => {
    expect(statusFromXY('A', ' ')).toBe('added');
    expect(statusFromXY(' ', 'M')).toBe('modified');
    expect(statusFromXY('M', ' ')).toBe('modified');
    expect(statusFromXY(' ', 'D')).toBe('deleted');
    expect(statusFromXY(' ', 'T')).toBe('modified'); // type change
  });

  it('keeps staged-then-worktree edits at their headline status (VSCode badge)', () => {
    expect(statusFromXY('A', 'M')).toBe('added'); // staged add, then edited
    expect(statusFromXY('R', 'M')).toBe('renamed'); // renamed, then edited
  });
});

describe('parsePorcelainStatus', () => {
  it('parses a rename (two paths), untracked, and ignored records', () => {
    // Exactly the byte layout `git status --porcelain=v1 -z` emits (verified):
    // a rename is `XY NEW\0OLD\0`; `??`/`!!` are single-path records.
    const raw = 'RM new.txt\0old.txt\0?? .gitignore\0?? fresh.txt\0!! junk.log\0';
    expect(parsePorcelainStatus(raw)).toEqual([
      { path: 'new.txt', status: 'renamed' },
      { path: '.gitignore', status: 'untracked' },
      { path: 'fresh.txt', status: 'untracked' },
      { path: 'junk.log', status: 'ignored' },
    ]);
  });

  it('handles paths with spaces', () => {
    const raw = ' M my file.txt\0';
    expect(parsePorcelainStatus(raw)).toEqual([{ path: 'my file.txt', status: 'modified' }]);
  });

  it('returns nothing for a clean worktree', () => {
    expect(parsePorcelainStatus('')).toEqual([]);
  });
});
