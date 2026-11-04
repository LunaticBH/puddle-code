import { win32 } from 'node:path';
import { execPath } from 'node:process';
import { system32Path, type Environment } from '@puddle/shared/node/platform';
import { powershellLiteral } from '../shell-quote.js';

/**
 * How Claude Code runs Puddle's helpers: the daemon's own Node on a script
 * path. The daemon's pinned node runs claude on this same host, so its path
 * is valid for the hook and status-line subprocesses too.
 *
 * POSIX: shell form, `"<node>" "<helper>" <args>` for `sh -c`.
 *
 * Windows, checked against the bundled source of Claude Code 2.1.248 on
 * Windows 11 and the hooks and status-line documentation (2026-11): a
 * shell-form command runs through Git Bash when Claude finds one, else
 * through PowerShell. Puddle cannot see which (Claude also reads
 * `CLAUDE_CODE_GIT_BASH_PATH` from its own settings), and the two need
 * incompatible quoting, so:
 * - hooks use exec form, `command` plus `args`, which Claude spawns directly
 *   with no shell (added in Claude Code 2.1.139);
 * - the status line, which has only a shell form, is one command that both
 *   shells, and cmd.exe, run alike; see {@link claudeStatusLineCommand}.
 * A logged-out 2.1.248 run with a scratch config dir fired a SessionStart
 * hook in each form, with spaces and an apostrophe in both paths and the
 * payload intact on stdin.
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

/**
 * A drive path that no shell Claude may use treats specially: bash, PowerShell
 * and cmd.exe all run `C:/…/node.exe C:/…/helper.mjs` written bare.
 */
const PLAIN_WINDOWS_PATH = /^[A-Za-z]:(?:\/[A-Za-z0-9._-]+)+$/;

/**
 * The status-line command running `node script`.
 *
 * POSIX: `"<node>" "<script>"` for `sh -c`.
 *
 * Windows: both paths bare with `/` separators when they hold only
 * characters no shell interprets. Otherwise Windows PowerShell runs
 * `& '<node>' '<script>'` from `-EncodedCommand` (base64 of UTF-16LE), text
 * that Git Bash, PowerShell and cmd.exe all pass through untouched; the
 * nested PowerShell costs about 200 ms per refresh. Both forms were run
 * through Git Bash (`bash -c`) and Claude's PowerShell invocation
 * (`-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`) with
 * `O'Neil $x` in the path and the payload intact on stdin.
 */
export function claudeStatusLineCommand(
  script: string,
  platform: NodeJS.Platform = process.platform,
  node: string = execPath,
  env: Environment = process.env,
): string {
  if (platform !== 'win32') return `${JSON.stringify(node)} ${JSON.stringify(script)}`;
  const plain = [node, script].map((path) => path.replaceAll('\\', '/'));
  if (plain.every((path) => PLAIN_WINDOWS_PATH.test(path))) return plain.join(' ');
  const powershell = system32Path(
    win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    env,
  ).replaceAll('\\', '/');
  const program = PLAIN_WINDOWS_PATH.test(powershell) ? powershell : 'powershell.exe';
  const encoded = Buffer.from(
    `& ${powershellLiteral(node)} ${powershellLiteral(script)}`,
    'utf16le',
  ).toString('base64');
  return `${program} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

/**
 * Whether a status-line entry runs the helper `file`: in plain view, or
 * inside the `-EncodedCommand` payload {@link claudeStatusLineCommand} writes.
 */
export function runsStatusLineHelper(entry: unknown, file: string): boolean {
  if (runsHelper(entry, file)) return true;
  const command = (entry as { command?: unknown } | null)?.command;
  if (typeof command !== 'string') return false;
  const encoded = /\s-EncodedCommand\s+([A-Za-z0-9+/]+={0,2})$/.exec(command)?.[1];
  return encoded !== undefined && Buffer.from(encoded, 'base64').toString('utf16le').includes(file);
}
