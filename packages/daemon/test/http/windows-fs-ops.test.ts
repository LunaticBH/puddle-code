import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/http/errors.js';
import {
  moveAcrossRoots,
  sameEntry,
  uniqueDestination,
  unlessInUse,
} from '../../src/http/routes/worktrees/worktree-fs-ops.js';

// Wrapped, not replaced: every call reaches the real filesystem unless a test
// makes one fail, which is how an EXDEV crossing and a held file are staged
// on a single volume.
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    renameSync: vi.fn(real.renameSync),
    cpSync: vi.fn(real.cpSync),
    rmSync: vi.fn(real.rmSync),
  };
});

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
  // Back to the real implementations, with no staged failure left over.
  vi.mocked(fs.renameSync).mockReset();
  vi.mocked(fs.cpSync).mockReset();
  vi.mocked(fs.rmSync).mockReset();
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

describe('moves across drives (F22)', () => {
  let from: string;
  let to: string;
  beforeEach(() => {
    from = join(dir, 'source', 'project');
    to = join(dir, 'destination', 'project');
    fs.mkdirSync(join(from, 'sub'), { recursive: true });
    fs.mkdirSync(join(dir, 'destination'));
    fs.writeFileSync(join(from, 'a.txt'), 'a');
    fs.writeFileSync(join(from, 'sub', 'b.txt'), 'b');
  });

  /** The first rename answers EXDEV, as a move to another volume does. */
  function crossDevice(): void {
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw errno('EXDEV');
    });
  }

  function intact(path: string): boolean {
    return (
      fs.readFileSync(join(path, 'a.txt'), 'utf8') === 'a' &&
      fs.readFileSync(join(path, 'sub', 'b.txt'), 'utf8') === 'b'
    );
  }

  it('moves by copy and removal, leaving no probe behind', () => {
    for (const platform of ['win32', 'linux'] as const) {
      crossDevice();
      moveAcrossRoots(from, to, 'project', platform);
      expect(intact(to)).toBe(true);
      expect(fs.existsSync(from)).toBe(false);
      expect(fs.readdirSync(join(dir, 'source'))).toEqual([]);
      fs.renameSync(to, from); // back again for the other platform
    }
  });

  it('copies nothing when Windows will not let the source go', () => {
    crossDevice();
    // The probe rename: what Windows answers while anything inside is open.
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw errno('EPERM');
    });
    const error = apiError(() =>
      unlessInUse('project', () => moveAcrossRoots(from, to, 'project', 'win32'), 'win32'),
    );
    expect(error.code).toBe('path_busy');
    expect(fs.cpSync).not.toHaveBeenCalled();
    expect(fs.existsSync(to)).toBe(false);
    expect(intact(from)).toBe(true);
  });

  it('reports a copied move whose source survives as done, not as one to retry', () => {
    crossDevice();
    vi.mocked(fs.rmSync).mockImplementationOnce(() => {
      throw errno('EPERM');
    });
    const error = apiError(() =>
      unlessInUse('project', () => moveAcrossRoots(from, to, 'project', 'win32'), 'win32'),
    );
    expect(error.code).toBe('source_not_removed');
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/^project was copied, but its original could not be removed/);
    expect(error.details).toEqual({ cause: 'EPERM' });
    expect(intact(to)).toBe(true);
  });

  it('keeps the POSIX move exactly: no probe, and a failed removal surfaces as it was', () => {
    crossDevice();
    const failure = errno('EACCES');
    vi.mocked(fs.rmSync).mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => moveAcrossRoots(from, to, 'project', 'linux')).toThrow(failure);
    expect(fs.renameSync).toHaveBeenCalledTimes(1);
    expect(intact(to)).toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    'leaves both sides untouched while a program holds the source open on Windows',
    async () => {
      // The child holds its working directory open once it is running.
      const holder = spawn(
        process.execPath,
        ['-e', "process.stdout.write('ready'); setTimeout(() => {}, 20000)"],
        { cwd: join(from, 'sub') },
      );
      try {
        await new Promise((resolve) => holder.stdout.once('data', resolve));
        crossDevice();
        const error = apiError(() =>
          unlessInUse('project', () => moveAcrossRoots(from, to, 'project'), 'win32'),
        );
        expect(error.code).toBe('path_busy');
        expect(fs.existsSync(to)).toBe(false);
        expect(intact(from)).toBe(true);
      } finally {
        holder.kill();
        await new Promise((resolve) => holder.once('exit', resolve));
      }
    },
  );
});
