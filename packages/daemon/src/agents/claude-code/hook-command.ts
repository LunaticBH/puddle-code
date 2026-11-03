import { existsSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { execPath } from 'node:process';
import { findExecutable, getEnv, type Environment } from '@puddle/shared/node/platform';
import { gitBashPathLiteral, powershellLiteral } from '../shell-quote.js';

/**
 * How Claude Code runs Puddle's helpers: the daemon's own Node on a script
 * path. The daemon's pinned node runs claude on this same host, so its path
 * is valid for the hook and status-line subprocesses too.
 *
 * POSIX: shell form, `"<node>" "<helper>" <args>` for `sh -c`.
 *
 * Windows, checked against the bundled source of Claude Code 2.1.248 on
 * Windows 11 and the hooks and status-line documentation (2026-11):
 * - A shell-form hook runs through Git Bash when Claude finds one, else
 *   through PowerShell, and the two need incompatible quoting (PowerShell
 *   prints a command that starts with a quoted string instead of running
 *   it). Hooks therefore use exec form, `command` plus `args`, which Claude
 *   spawns directly with no shell (added in Claude Code 2.1.139).
 * - The status line has only a shell form, so it is quoted for the shell
 *   Claude will pick; see {@link claudeFindsGitBash}.
 * A logged-out 2.1.248 run with a scratch config dir fired a SessionStart
 * hook in each of the three forms, with spaces and an apostrophe in both
 * paths and the payload intact on stdin.
 */
export interface ClaudeCommandHook {
  type: 'command';
  command: string;
  args?: string[];
}

export function claudeHook(
  script: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ClaudeCommandHook {
  if (platform === 'win32') return { type: 'command', command: execPath, args: [script, ...args] };
  return {
    type: 'command',
    command: [JSON.stringify(execPath), JSON.stringify(script), ...args].join(' '),
  };
}

/** Whether a settings entry runs the helper `file`, in shell or exec form. */
export function runsHelper(entry: unknown, file: string): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  const { command, args } = entry as { command?: unknown; args?: unknown };
  return (
    (typeof command === 'string' && command.includes(file)) ||
    (Array.isArray(args) && args.some((arg) => typeof arg === 'string' && arg.includes(file)))
  );
}

/** The shell Claude Code runs a status-line command through. */
export type StatusLineShell = 'posix' | 'git-bash' | 'powershell';

export function claudeStatusLineShell(
  platform: NodeJS.Platform = process.platform,
  env: Environment = process.env,
): StatusLineShell {
  if (platform !== 'win32') return 'posix';
  return claudeFindsGitBash(env) ? 'git-bash' : 'powershell';
}

export function claudeStatusLineCommand(script: string, shell: StatusLineShell): string {
  if (shell === 'posix') return `${JSON.stringify(execPath)} ${JSON.stringify(script)}`;
  if (shell === 'git-bash') return `${gitBashPathLiteral(execPath)} ${gitBashPathLiteral(script)}`;
  return `& ${powershellLiteral(execPath)} ${powershellLiteral(script)}`;
}

/**
 * Claude Code 2.1.248's Git Bash discovery, in its order: a
 * `CLAUDE_CODE_GIT_BASH_PATH` naming an existing bash or sh, a Git install
 * under either Program Files, then `..\..\bin\bash.exe` beside `git` on PATH.
 */
export function claudeFindsGitBash(env: Environment = process.env): boolean {
  const configured = getEnv(env, 'CLAUDE_CODE_GIT_BASH_PATH', 'win32');
  if (
    configured &&
    ['bash.exe', 'sh.exe', 'bash', 'sh'].includes(win32.basename(configured).toLowerCase()) &&
    existsSync(configured)
  ) {
    return true;
  }
  const installs = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  if (installs.some((path) => existsSync(path))) return true;
  const git = findExecutable('git', { platform: 'win32', env });
  return git !== null && existsSync(join(git, '..', '..', 'bin', 'bash.exe'));
}
