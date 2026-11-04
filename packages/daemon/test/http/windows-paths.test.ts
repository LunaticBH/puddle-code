import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitError } from '../../src/git/exec.js';
import { ApiError } from '../../src/http/errors.js';
import { removeDirWithin } from '../../src/http/fs-cleanup.js';
import { dirsQuery } from '../../src/http/routes/fs.js';
import { unsafeRepository } from '../../src/http/routes/repos.js';
import { sameEntry, unlessInUse } from '../../src/http/routes/worktrees/worktree-fs-ops.js';
import {
  absoluteDir,
  assertStorableName,
  containedPath,
  containedWritePath,
  gitRelativePath,
} from '../../src/http/routes/worktrees/worktree-shared.js';
import { expandTilde } from '../../src/http/tilde.js';

/**
 * The Windows branches of the HTTP path handling, driven through their
 * injected `platform` so they run on every host (docs/windows.md, decision 11).
 */

function code(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
}

/** The POSIX branches keep the host's own `node:path`, so they are checked on POSIX hosts. */
const onPosix = process.platform !== 'win32';

describe('tilde expansion', () => {
  it.runIf(onPosix)('keeps the POSIX rules exactly', () => {
    expect(expandTilde('~', 'linux', '/home/a')).toBe('/home/a');
    expect(expandTilde('~/src', 'linux', '/home/a')).toBe('/home/a/src');
    expect(expandTilde('~/', 'linux', '/home/a')).toBe('/home/a/');
    expect(expandTilde('~\\src', 'linux', '/home/a')).toBe('~\\src');
    expect(expandTilde('~other/x', 'linux', '/home/a')).toBe('~other/x');
  });

  it('accepts ~\\ and ~/ on Windows, keeping a trailing separator as \\', () => {
    const home = 'C:\\Users\\a';
    expect(expandTilde('~', 'win32', home)).toBe(home);
    expect(expandTilde('~\\src\\app', 'win32', home)).toBe('C:\\Users\\a\\src\\app');
    expect(expandTilde('~/src/app', 'win32', home)).toBe('C:\\Users\\a\\src\\app');
    expect(expandTilde('~\\', 'win32', home)).toBe('C:\\Users\\a\\');
    expect(expandTilde('~/src/', 'win32', home)).toBe('C:\\Users\\a\\src\\');
    expect(expandTilde('C:\\x', 'win32', home)).toBe('C:\\x');
  });
});

describe('directory autocomplete prefixes', () => {
  it.runIf(onPosix)('keeps the POSIX split', () => {
    expect(dirsQuery('/a/b/par', 'linux')).toEqual({ parent: '/a/b', partial: 'par' });
    expect(dirsQuery('/a/b/', 'linux')).toEqual({ parent: '/a/b/', partial: '' });
    expect(code(() => dirsQuery('a/b', 'linux'))).toBe('invalid_prefix');
  });

  it('lists from either separator on Windows and stops at the drive root', () => {
    const missing = 'c:/no-such-puddle-dir';
    expect(dirsQuery(`${missing}/sub/`, 'win32')).toEqual({
      parent: 'C:\\no-such-puddle-dir\\sub',
      partial: '',
    });
    expect(dirsQuery(`${missing}\\Par`, 'win32')).toEqual({
      parent: 'C:\\no-such-puddle-dir',
      partial: 'par',
    });
    expect(dirsQuery('C:', 'win32').partial).toBe('');
    expect(dirsQuery('C:', 'win32').parent).toMatch(/^C:\\$/);
    for (const prefix of ['', '/', '\\Users', 'C:Users', 'relative\\dir']) {
      expect(
        code(() => dirsQuery(prefix, 'win32')),
        prefix,
      ).toBe('invalid_prefix');
    }
  });
});

describe('Windows confinement', () => {
  const root = 'C:\\Users\\a\\wt';

  it('contains either separator and compares case-insensitively', () => {
    expect(containedPath(root, 'src/a.ts', 'win32')).toBe('C:\\Users\\a\\wt\\src\\a.ts');
    expect(containedPath(root, 'src\\a.ts', 'win32')).toBe('C:\\Users\\a\\wt\\src\\a.ts');
    expect(containedPath(root, '', 'win32')).toBe(root);
    expect(containedPath('c:/users/A/WT', 'x', 'win32')).toBe('c:\\users\\A\\WT\\x');
    expect(containedPath('C:\\', 'Users\\a', 'win32')).toBe('C:\\Users\\a');
  });

  it('rejects drives, roots and climbs in either spelling', () => {
    for (const rel of [
      '..\\x',
      '../x',
      'a\\..\\..\\x',
      'C:\\x',
      'D:x',
      '\\x',
      '/x',
      '\\\\srv\\s',
    ]) {
      expect(
        code(() => containedPath(root, rel, 'win32')),
        rel,
      ).toBe('path_outside_worktree');
    }
    expect(code(() => containedPath('C:\\repo', '..\\repo-evil\\x', 'win32'))).toBe(
      'path_outside_worktree',
    );
  });

  it('refuses names Windows cannot store only on writes, after the escape check', () => {
    expect(containedPath(root, 'f.txt:stream', 'win32')).toBe('C:\\Users\\a\\wt\\f.txt:stream');
    expect(code(() => containedWritePath(root, 'f.txt:stream', 'win32'))).toBe('invalid_name');
    expect(code(() => containedWritePath(root, 'docs\\CON.md', 'win32'))).toBe('invalid_name');
    expect(code(() => containedWritePath(root, 'trailing./x', 'win32'))).toBe('invalid_name');
    expect(code(() => containedWritePath(root, 'C:\\abs.txt', 'win32'))).toBe(
      'path_outside_worktree',
    );
    expect(containedWritePath(root, 'docs/./a.md', 'win32')).toBe('C:\\Users\\a\\wt\\docs\\a.md');
    expect(code(() => assertStorableName('ok/fine.txt'))).toBeNull();
  });

  it.runIf(onPosix)('leaves POSIX names alone', () => {
    expect(containedWritePath('/wt', 'f.txt:stream', 'linux')).toBe('/wt/f.txt:stream');
    expect(containedWritePath('/wt', 'CON', 'linux')).toBe('/wt/CON');
  });

  it('accepts only drive and UNC roots as absolute directories', () => {
    for (const raw of ['/', '\\Users', 'C:Users', 'relative']) {
      expect(
        code(() => absoluteDir(raw, 'win32')),
        raw,
      ).toBe('invalid_root');
    }
  });
});

describe('git blob paths', () => {
  it.runIf(onPosix)('keeps the POSIX guard', () => {
    expect(gitRelativePath('a/b.ts', 'linux')).toBe('a/b.ts');
    expect(gitRelativePath('', 'linux')).toBe('');
    expect(gitRelativePath('a\\b.ts', 'linux')).toBe('a\\b.ts'); // a legal POSIX name
    expect(code(() => gitRelativePath('/etc/passwd', 'linux'))).toBe('path_outside_worktree');
    expect(code(() => gitRelativePath('../x', 'linux'))).toBe('path_outside_worktree');
  });

  it('answers with / on Windows whatever separator was sent', () => {
    expect(gitRelativePath('src\\a.ts', 'win32')).toBe('src/a.ts');
    expect(gitRelativePath('src/./a.ts', 'win32')).toBe('src/a.ts');
    expect(gitRelativePath('', 'win32')).toBe('');
    for (const rel of ['..\\x', '\\x', '/x', 'C:\\x', 'C:x']) {
      expect(
        code(() => gitRelativePath(rel, 'win32')),
        rel,
      ).toBe('path_outside_worktree');
    }
  });
});

describe('Windows file operations', () => {
  it('maps in-use errors to 409 path_busy on Windows only', () => {
    const busy = Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    const fail = () => {
      throw busy;
    };
    expect(code(() => unlessInUse('held', fail, 'win32'))).toBe('path_busy');
    expect(() => unlessInUse('held', fail, 'linux')).toThrow(busy);
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    expect(() =>
      unlessInUse(
        'gone',
        () => {
          throw missing;
        },
        'win32',
      ),
    ).toThrow(missing);
    expect(unlessInUse('fine', () => 42, 'win32')).toBe(42);
  });

  // Case-only renames compare the entries on disk: windows-fs-ops.test.ts.
  it('never treats two spellings as one entry on POSIX, or without the files', () => {
    expect(sameEntry('C:\\wt\\a.md', 'C:\\wt\\b.md', 'win32')).toBe(false);
    expect(sameEntry('C:\\wt\\a.md', 'C:\\wt\\a.md', 'win32')).toBe(false);
    expect(sameEntry('C:\\no-such\\readme.md', 'C:\\no-such\\README.md', 'win32')).toBe(false);
    expect(sameEntry('/wt/readme.md', '/wt/README.md', 'linux')).toBe(false);
  });
});

describe('repository registration', () => {
  const dubious = new GitError(
    ['rev-parse', '--git-dir'],
    128,
    "fatal: detected dubious ownership in repository at 'D:/repo'\n" +
      "To add an exception for this directory, call:\n\n\tgit config --global --add safe.directory 'D:/repo'\n",
  );

  it('reports git safe.directory refusals as unsafe_repository on Windows', () => {
    const error = unsafeRepository(dubious, 'win32');
    expect(error?.code).toBe('unsafe_repository');
    expect(error?.message).toContain('safe.directory');
    expect(unsafeRepository(dubious, 'linux')).toBeNull();
    expect(unsafeRepository(new GitError([], 128, 'not a git repository'), 'win32')).toBeNull();
    expect(unsafeRepository(new Error('dubious ownership'), 'win32')).toBeNull();
  });
});

describe('removeDirWithin', () => {
  it('removes only directories strictly inside the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'puddle-cleanup-'));
    try {
      const inside = join(root, 'profiles', 'p');
      mkdirSync(inside, { recursive: true });
      writeFileSync(join(inside, 'f'), 'x');
      removeDirWithin(root, root);
      expect(existsSync(root)).toBe(true);
      removeDirWithin(join(root, 'profiles'), inside);
      expect(existsSync(inside)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')(
    'accepts a root spelt with another case and separators on Windows',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'puddle-cleanup-'));
      try {
        const inside = join(root, 'p');
        mkdirSync(inside);
        removeDirWithin(root.toUpperCase().replaceAll('\\', '/'), inside);
        expect(existsSync(inside)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
