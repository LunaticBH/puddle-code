import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backgroundGitEnv, git, gitArgv, GitError } from '../../src/git/exec.js';

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
