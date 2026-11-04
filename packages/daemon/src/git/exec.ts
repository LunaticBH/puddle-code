import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { findExecutable, getEnv, setEnv } from '@puddle/shared/node/platform';

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (${exitCode}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  cwd?: string;
  /** Replaces the inherited environment (see `backgroundGitEnv`). */
  env?: NodeJS.ProcessEnv;
  /** Written to git's stdin, e.g. `--pathspec-from-file=-` lists or `commit -F -`. */
  input?: string;
}

/**
 * The argv git actually receives. Windows prepends `core.longpaths`, because
 * session worktrees under `%USERPROFILE%\.puddle\worktrees\<id>\<uuid>` leave
 * little of MAX_PATH for a deep checkout (node_modules, Java packages) and Git
 * for Windows leaves the setting off by default. `GitError.args` keeps the
 * caller's own argv.
 */
export function gitArgv(args: string[], platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['-c', 'core.longpaths=true', ...args] : args;
}

/**
 * The environment for git work nobody is watching: background and create-time
 * fetches. On Windows, Git Credential Manager and the bundled askpass helpers
 * would open sign-in or passphrase dialogs from the headless daemon on every
 * periodic fetch, so prompts are switched off and the fetch fails quietly, as
 * it does on a tty-less POSIX host. POSIX inherits the environment unchanged
 * (undefined). User-initiated fetch, pull and push keep the inherited
 * environment everywhere, so Credential Manager can still sign the user in.
 */
export function backgroundGitEnv(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  if (platform !== 'win32') return undefined;
  const quiet = { ...env };
  setEnv(quiet, 'GIT_TERMINAL_PROMPT', '0', platform);
  setEnv(quiet, 'GCM_INTERACTIVE', 'never', platform);
  setEnv(quiet, 'SSH_ASKPASS_REQUIRE', 'never', platform);
  return quiet;
}

let resolvedGit: { path: string | undefined; file: string } | null = null;

/**
 * The program git runs as. POSIX keeps the bare name: execvp searches PATH
 * only. Windows resolves it here, because libuv would look for a bare `git`
 * in the child's working directory before PATH, and every git child runs in
 * a repository or worktree, where a tracked `git.exe` would run as the user
 * on the first status poll. Only `.com` and `.exe` count, the extensions libuv
 * itself tries, since Node will not start a batch file without a shell. The
 * result is reused while PATH is unchanged. Throws ENOENT when PATH has no
 * git.
 */
export function gitExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== 'win32') return 'git';
  const path = getEnv(env, 'PATH', platform);
  if (resolvedGit && resolvedGit.path === path) return resolvedGit.file;
  const file = findExecutable('git', { platform, env, pathext: '.COM;.EXE' });
  if (file === null || !win32.isAbsolute(file)) {
    throw Object.assign(new Error("spawn git ENOENT: git.exe was not found on the daemon's PATH"), {
      code: 'ENOENT',
      syscall: 'spawn git',
      path: 'git',
    });
  }
  resolvedGit = { path, file };
  return file;
}

/** A spawn that found nothing (git uninstalled or moved) forgets the cached path. */
function forgetMissingGit(err: { code?: unknown }): void {
  if (err.code === 'ENOENT') resolvedGit = null;
}

/** All puddle git operations go through here: uniform errors, no shell quoting. */
export function git(args: string[], opts: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    let file: string;
    try {
      file = gitExecutable(process.platform, opts.env);
    } catch (err) {
      reject(new GitError(args, null, (err as Error).message));
      return;
    }
    const child = execFile(
      file,
      gitArgv(args),
      {
        cwd: opts.cwd,
        env: opts.env,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        // A detached Windows daemon has no console: without this every git.exe
        // child (status polls included) would flash a console window.
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          forgetMissingGit(err);
          const code = typeof err.code === 'number' ? err.code : null;
          reject(new GitError(args, code, stderr || err.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
    if (opts.input !== undefined && child.stdin) {
      // Git can exit before it reads stdin: index.lock held by another git,
      // or a pre-commit hook failing before `commit -F -` reads the message.
      // With more than a pipe buffer (~64 KiB) still unwritten, the write
      // then fails with EPIPE/EOF, and an unhandled stream 'error' would end
      // the daemon. Git's own exit status and stderr still reach the callback
      // above as a GitError, so the stream error itself is ignored.
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input);
    }
  });
}

/**
 * Same choke point as `git()`, for callers that need raw bytes: blob reads
 * (`git show <ref>:<path>`) must not go through `git()`'s `.trim()`, which
 * would silently corrupt a file's trailing newline or binary content.
 */
export function gitBuffer(args: string[], opts: { cwd: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let file: string;
    try {
      file = gitExecutable();
    } catch (err) {
      reject(new GitError(args, null, (err as Error).message));
      return;
    }
    execFile(
      file,
      gitArgv(args),
      { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer', windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          forgetMissingGit(err);
          const code = typeof err.code === 'number' ? err.code : null;
          const message = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : err.message;
          reject(new GitError(args, code, message || err.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
