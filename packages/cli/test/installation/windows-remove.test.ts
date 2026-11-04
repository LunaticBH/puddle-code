import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { system32Path } from '@puddle/shared/node/platform';
import {
  removeWindowsDaemon,
  sweepWindowsWorktrees,
} from '../../src/lib/installation/windows-remove.js';

function git(dir: string, ...args: string[]) {
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  );
}

/** A home with one clean, one dirty and one unpushed worktree under worktrees/<repo>/<dir>. */
function homeWithWorktrees() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-windows-remove-'));
  const make = (name: string) => {
    const dir = join(home, 'worktrees', '1', name);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore', windowsHide: true });
    return dir;
  };
  const clean = make('clean');
  const dirty = make('dirty');
  writeFileSync(join(dirty, 'notes.txt'), 'unsaved');
  const unpushed = make('unpushed');
  git(unpushed, 'commit', '--allow-empty', '-q', '-m', 'local only');
  mkdirSync(join(home, 'worktrees', '1', 'not-a-checkout'));
  return { home, clean, dirty, unpushed };
}

describe('removing the daemon from this Windows machine', () => {
  it('sweeps worktrees for uncommitted or unpushed work', async () => {
    const { home, dirty, unpushed } = homeWithWorktrees();
    expect((await sweepWindowsWorktrees(home)).sort()).toEqual([dirty, unpushed].sort());
    expect(await sweepWindowsWorktrees(join(home, 'absent'))).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(
    'never runs a git.exe planted in the directory the removal starts from',
    async () => {
      const { home, dirty, unpushed } = homeWithWorktrees();
      const start = mkdtempSync(join(tmpdir(), 'puddle-windows-remove-cwd-'));
      // Any executable will do: hostname.exe fails on git's argv, so nothing reads as dirty.
      copyFileSync(system32Path('hostname.exe'), join(start, 'git.exe'));
      // A plain user environment: Claude Code's own shells set this, hiding the lookup.
      const saved = process.env.NoDefaultCurrentDirectoryInExePath;
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      const cwd = process.cwd();
      process.chdir(start);
      try {
        expect((await sweepWindowsWorktrees(home)).sort()).toEqual([dirty, unpushed].sort());
      } finally {
        process.chdir(cwd);
        if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved;
        rmSync(start, { recursive: true, force: true });
      }
    },
  );

  it('removes the install but keeps the data, never following a junction out', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-windows-remove-'));
    const outside = mkdtempSync(join(tmpdir(), 'puddle-windows-outside-'));
    writeFileSync(join(outside, 'precious.txt'), 'keep');
    mkdirSync(join(home, 'bin', 'versions', '1.2.3'), { recursive: true });
    symlinkSync(
      outside,
      join(home, 'bin', 'current'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    for (const name of ['runtime.json', 'supervisor', 'puddled.pid', 'puddle.db', 'token']) {
      writeFileSync(join(home, name), '');
    }
    mkdirSync(join(home, 'cache'));
    const lines: string[] = [];
    await removeWindowsDaemon(home, {
      purge: false,
      logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    });
    for (const name of ['bin', 'cache', 'runtime.json', 'supervisor', 'puddled.pid']) {
      expect(existsSync(join(home, name))).toBe(false);
    }
    expect(existsSync(join(home, 'puddle.db'))).toBe(true);
    expect(existsSync(join(home, 'token'))).toBe(true);
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
    expect(lines).toContain(`puddled remove: removed the install; data kept under ${home}`);
  });

  it('purges the whole home on request', async () => {
    const { home } = homeWithWorktrees();
    const lines: string[] = [];
    await removeWindowsDaemon(home, {
      purge: true,
      logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    });
    expect(existsSync(home)).toBe(false);
    expect(lines).toContain(`puddled remove: deleted ${home}`);
  });
});
