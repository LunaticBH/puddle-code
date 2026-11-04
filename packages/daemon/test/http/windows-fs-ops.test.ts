import { describe, expect, it } from 'vitest';
import { uniqueDestination } from '../../src/http/routes/worktrees/worktree-fs-ops.js';

/**
 * The Windows branches of the explorer's file operations (docs/windows.md,
 * decision 11), driven through their injected `platform` so they run on every
 * host. The POSIX branches are checked to be what they always were.
 */

describe('copy names (F24)', () => {
  const taken = (...paths: string[]) => {
    const set = new Set(paths);
    return (path: string) => set.has(path);
  };

  it('keeps the whole name when copying into a Windows drive or share root', () => {
    expect(uniqueDestination('D:\\notes.txt', 'win32', taken('D:\\notes.txt'))).toBe(
      'D:\\notes copy.txt',
    );
    expect(uniqueDestination('D:\\bar', 'win32', taken('D:\\bar', 'D:\\bar copy'))).toBe(
      'D:\\bar copy 2',
    );
    expect(
      uniqueDestination('\\\\srv\\share\\a.txt', 'win32', taken('\\\\srv\\share\\a.txt')),
    ).toBe('\\\\srv\\share\\a copy.txt');
    expect(uniqueDestination('C:\\wt\\.gitignore', 'win32', taken('C:\\wt\\.gitignore'))).toBe(
      'C:\\wt\\.gitignore copy',
    );
    expect(uniqueDestination('D:\\free.txt', 'win32', taken())).toBe('D:\\free.txt');
  });

  it('keeps the POSIX names below the root exactly', () => {
    expect(uniqueDestination('/wt/notes.txt', 'linux', taken('/wt/notes.txt'))).toBe(
      '/wt/notes copy.txt',
    );
    expect(uniqueDestination('/wt/.env', 'linux', taken('/wt/.env', '/wt/.env copy'))).toBe(
      '/wt/.env copy 2',
    );
  });
});
