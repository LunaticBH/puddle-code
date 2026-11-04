import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/http/errors.js';
import {
  sameEntry,
  uniqueDestination,
  unlessInUse,
} from '../../src/http/routes/worktrees/worktree-fs-ops.js';

/**
 * The Windows branches of the explorer's file operations (docs/windows.md,
 * decision 11), driven through their injected `platform` so they run on every
 * host. The POSIX branches are checked to be what they always were.
 */

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: staged failure`), { code });
}

function apiError(run: () => unknown): ApiError {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected an ApiError');
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'puddle-fs-ops-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

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

describe('case-only renames (F21)', () => {
  it('is the same entry only when both spellings open one file', () => {
    const lower = join(dir, 'readme.md');
    fs.writeFileSync(lower, 'lower');
    const upper = join(dir, 'README.md');
    // A case-sensitive directory keeps a second, different file under the
    // other spelling; a case-insensitive one (or a hard link) names the same.
    if (!fs.existsSync(upper)) fs.writeFileSync(upper, 'upper');
    const distinct = fs.readFileSync(upper, 'utf8') === 'upper';
    expect(sameEntry(lower, upper, 'win32')).toBe(!distinct);
    if (distinct) {
      fs.rmSync(upper);
      fs.linkSync(lower, upper);
      expect(sameEntry(lower, upper, 'win32')).toBe(true);
    }
  });

  it('is never the same entry for a missing target, another name or POSIX', () => {
    const file = join(dir, 'a.md');
    fs.writeFileSync(file, 'a');
    expect(sameEntry(join(dir, 'gone.md'), join(dir, 'GONE.md'), 'win32')).toBe(false);
    expect(sameEntry(file, join(dir, 'b.md'), 'win32')).toBe(false);
    expect(sameEntry(file, file, 'win32')).toBe(false);
    expect(sameEntry(file, join(dir, 'A.md'), 'linux')).toBe(false);
  });
});

describe('refusals Windows cannot attribute (F25)', () => {
  const failing = (code: string) => () => {
    throw errno(code);
  };

  it('names both causes for access denied, keeping the original code', () => {
    for (const code of ['EPERM', 'EACCES']) {
      const error = apiError(() => unlessInUse('src/app.log', failing(code), 'win32'));
      expect(error.code).toBe('path_busy');
      expect(error.status).toBe(409);
      expect(error.message).toBe(
        'src/app.log could not be changed: it is open in another program (a terminal, editor or dev server), or you do not have permission to change it',
      );
      expect(error.details).toEqual({ cause: code });
    }
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('EPERM: staged failure'));
  });

  it('keeps the sharing-violation wording for EBUSY', () => {
    const error = apiError(() => unlessInUse('', failing('EBUSY'), 'win32'));
    expect(error.message).toBe(
      '. is in use by another program (a terminal, editor or dev server); close it and try again',
    );
    expect(error.details).toEqual({ cause: 'EBUSY' });
  });

  it('passes every error through on POSIX', () => {
    const denied = errno('EACCES');
    expect(() =>
      unlessInUse(
        'x',
        () => {
          throw denied;
        },
        'linux',
      ),
    ).toThrow(denied);
  });
});
