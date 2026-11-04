import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { system32Path } from '@puddle/shared/node/platform';
import {
  backgroundGitEnv,
  git,
  gitArgv,
  gitBuffer,
  GitError,
  gitExecutable,
} from '../../src/git/exec.js';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-git-exec-'));
  temporary.push(dir);
  return dir;
}

describe('git argv', () => {
  it('is the caller’s own on POSIX', () => {
    expect(gitArgv(['status'], 'linux')).toEqual(['status']);
    expect(gitArgv(['status'], 'darwin')).toEqual(['status']);
  });

  it('enables long paths on Windows, for deep session worktrees', () => {
    expect(gitArgv(['worktree', 'add', 'x'], 'win32')).toEqual([
      '-c',
      'core.longpaths=true',
      'worktree',
      'add',
      'x',
    ]);
  });

  it('reports the caller’s argv in errors, not the prefixed one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-git-exec-'));
    try {
      const error = await git(['rev-parse', '--verify', 'no-such-ref'], { cwd: dir }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).args).toEqual(['rev-parse', '--verify', 'no-such-ref']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('feeds stdin when given input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-git-exec-'));
    try {
      await git(['init', '-q'], { cwd: dir });
      const oid = await git(['hash-object', '--stdin'], { cwd: dir, input: 'hello\n' });
      expect(oid).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('git executable', () => {
  it('is the bare name on POSIX, which execvp looks up on PATH only', () => {
    expect(gitExecutable('linux', {})).toBe('git');
    expect(gitExecutable('darwin', { PATH: '' })).toBe('git');
  });

  it('is the absolute git.exe from PATH on Windows, skipping batch files and relative entries', () => {
    const wrapper = directory();
    writeFileSync(join(wrapper, 'git.cmd'), '');
    const bin = directory();
    writeFileSync(join(bin, 'git.exe'), '');
    expect(gitExecutable('win32', { Path: ['.', 'cmd', wrapper, bin].join(';') })).toBe(
      join(bin, 'git.exe'),
    );
    let error: unknown;
    try {
      gitExecutable('win32', { Path: wrapper });
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: 'ENOENT', path: 'git' });
  });

  it('rejects with a GitError when PATH has no git', async () => {
    const error = await git(['--version'], { env: { PATH: directory() } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).stderr).toMatch(/ENOENT/);
  });

  it.runIf(process.platform === 'win32')(
    'never runs a git.exe planted in the working directory',
    async () => {
      const repo = directory();
      // Any executable will do: hostname.exe fails on git's argv.
      copyFileSync(system32Path('hostname.exe'), join(repo, 'git.exe'));
      // A plain user environment: Claude Code's own shells set this, hiding the lookup.
      const saved = process.env.NoDefaultCurrentDirectoryInExePath;
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      try {
        expect(await git(['--version'], { cwd: repo })).toMatch(/^git version /);
        expect((await gitBuffer(['--version'], { cwd: repo })).toString('utf8')).toMatch(
          /^git version /,
        );
      } finally {
        if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved;
      }
    },
  );
});

describe('background git environment', () => {
  it('inherits the environment unchanged on POSIX', () => {
    expect(backgroundGitEnv('linux', { PATH: '/bin' })).toBeUndefined();
    expect(backgroundGitEnv('darwin', { PATH: '/bin' })).toBeUndefined();
  });

  it('switches every credential prompt off on Windows without touching the original', () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows', git_terminal_prompt: '1' };
    const quiet = backgroundGitEnv('win32', env);
    expect(quiet).toEqual({
      Path: 'C:\\Windows',
      git_terminal_prompt: '0', // an existing spelling is reused, never duplicated
      GCM_INTERACTIVE: 'never',
      SSH_ASKPASS_REQUIRE: 'never',
    });
    expect(env.git_terminal_prompt).toBe('1');
  });
});
