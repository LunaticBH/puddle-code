import { resolveSpawn, setEnv } from '@puddle/shared/node/platform';

/** An explicit, one-shot programme before an ordinary interactive session shell. */
export interface TerminalCommand {
  cwd: string;
  env?: Record<string, string>;
  commands: Array<{ file: string; args: string[] }>;
}

/** POSIX quoting keeps already-parsed command arguments literal, including source paths. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The PTY programme and arguments that run `command` and then hand over to
 * the session shell. POSIX wraps both in `/bin/sh -c`; Windows, which has
 * neither a POSIX shell nor exec, runs the daemon's own Node on an inline
 * wrapper script (docs/windows.md decision 13).
 */
export function terminalCommandSpawn(
  command: TerminalCommand,
  shell: string,
  shellArgs: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform === 'win32') return windowsRunWrapperSpawn(command, shell, shellArgs);
  return { file: '/bin/sh', args: terminalCommandArgs(command, shell, shellArgs) };
}

export function terminalCommandArgs(
  command: TerminalCommand,
  shell: string,
  shellArgs: string[],
): string[] {
  const commands = command.commands.map(({ file, args }) => [file, ...args].map(quote).join(' '));
  return [
    '-c',
    [
      // Catch SIGINT in the waiting wrapper; the foreground child retains its
      // normal signal disposition. Ctrl+C must return to a usable shell.
      "trap ':' INT",
      `printf '%s\\n' ${quote(commands.join(' && '))}`,
      // env executes external programmes even when a name also denotes a shell
      // builtin. No template or filename is interpreted as shell source.
      commands.map((line) => `/usr/bin/env -- ${line}`).join(' &&\n'),
      '_puddle_exit_status=$?',
      'printf "\\n[Process exited with status %s]\\n" "$_puddle_exit_status"',
      'trap - INT',
      `exec ${[shell, ...shellArgs].map(quote).join(' ')}`,
    ].join('\n'),
  ];
}

// --- Windows -------------------------------------------------------------------

/** One process the Windows wrapper starts, already resolved by `resolveSpawn`. */
export interface RunWrapperStep {
  file: string;
  args: string[];
  /** The cmd.exe command line in `args` is already quoted. */
  verbatim?: true;
  /** Variables an unwrapped npm/pnpm shim would have set. */
  env?: Record<string, string>;
}

/** Everything the Windows wrapper does, passed as one base64 JSON argument. */
export interface RunWrapperPlan {
  /** The command line printed first, as the POSIX wrapper's printf does. */
  banner: string;
  /** The command's variables, applied over every spelling the PTY inherited. */
  env: Record<string, string>;
  commands: RunWrapperStep[];
  shell: RunWrapperStep;
}

/**
 * The Windows wrapper, run with `node -e`. It is a single line without double
 * quotes or backslashes, so node-pty's command-line quoting passes it intact.
 *
 * It ignores Ctrl+C and Ctrl+Break itself for its whole life, while the
 * console delivers them to the programme as usual; runs each command with its
 * arguments passed literally, stopping at the first failure; prints the same
 * `[Process exited with status N]` line as POSIX; then runs the session shell
 * with inherited stdio and exits with its status. A programme ended by Ctrl+C
 * (STATUS_CONTROL_C_EXIT) reports 130, as a shell reports SIGINT; one that
 * cannot start reports 127 or 126 with the error, like env(1). A file that is
 * not an absolute path (a bare name the daemon did not find on PATH; it
 * resolves relative paths itself) is never spawned: libuv would look for it
 * in the working directory, the worktree, before PATH, so it reports 127 at
 * once. Each status line waits for its write, since console writes are
 * asynchronous on Windows.
 */
export const RUN_WRAPPER = `
'use strict';
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const { win32 } = require('node:path');
const NL = String.fromCharCode(10);
const plan = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
for (const signal of ['SIGINT', 'SIGBREAK']) process.on(signal, () => {});
const overlay = (base, extra) => {
  const names = new Set(Object.keys(extra).map((name) => name.toUpperCase()));
  const env = {};
  for (const [name, value] of Object.entries(base)) if (!names.has(name.toUpperCase())) env[name] = value;
  return Object.assign(env, extra);
};
const env = overlay(process.env, plan.env);
const write = (text) => new Promise((resolve) => process.stdout.write(text, () => resolve()));
const status = (code, signal) => code === 3221225786 ? 130 : code !== null ? code : 128 + (constants.signals[signal] || 0);
const run = (step) => new Promise((resolve) => {
  let settled = false;
  const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
  const fail = (error) => {
    process.stderr.write(step.file + ': ' + error.message + NL);
    settle(error.code === 'ENOENT' ? 127 : 126);
  };
  if (!win32.isAbsolute(step.file)) {
    fail(Object.assign(new Error('spawn ' + step.file + ' ENOENT'), { code: 'ENOENT' }));
    return;
  }
  try {
    const child = spawn(step.file, step.args, { stdio: 'inherit', env: overlay(env, step.env || {}), windowsVerbatimArguments: step.verbatim === true });
    child.once('error', fail);
    child.once('exit', (code, signal) => settle(status(code, signal)));
  } catch (error) {
    fail(error);
  }
});
(async () => {
  await write(plan.banner + NL);
  let code = 0;
  for (const step of plan.commands) {
    code = await run(step);
    if (code !== 0) break;
  }
  await write(NL + '[Process exited with status ' + code + ']' + NL);
  process.exit(await run(plan.shell));
})();
`
  .trim()
  .replace(/\n\s*/g, ' ');

/**
 * `process.execPath -e RUN_WRAPPER <plan>`. The daemon always runs on a real
 * node.exe (the release bundles one), so the wrapper needs no file beside the
 * bundled daemon. Commands are resolved here, against the daemon's
 * environment with the command's variables applied: npm shims become
 * `node <script>` and other batch files run through cmd.exe with strict
 * quoting, which throws `UnsafeCmdArgumentError` for an argument cmd.exe
 * cannot carry. A relative path such as `.\tools\build.exe` becomes the file
 * in the command's working directory, as on POSIX. A bare name that is not on
 * PATH stays bare, and the wrapper refuses to spawn it.
 */
function windowsRunWrapperSpawn(
  command: TerminalCommand,
  shell: string,
  shellArgs: string[],
): { file: string; args: string[] } {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [name, value] of Object.entries(command.env ?? {})) setEnv(env, name, value, 'win32');
  const step = (file: string, args: string[]): RunWrapperStep => {
    const resolved = resolveSpawn(file, args, { platform: 'win32', env, cwd: command.cwd });
    return {
      file: resolved.file,
      args: resolved.args,
      ...(resolved.windowsVerbatimArguments ? { verbatim: true as const } : {}),
      ...(resolved.env ? { env: resolved.env } : {}),
    };
  };
  const plan: RunWrapperPlan = {
    banner: command.commands
      .map(({ file, args }) => [file, ...args].map(displayWord).join(' '))
      .join(' && '),
    env: command.env ?? {},
    commands: command.commands.map(({ file, args }) => step(file, args)),
    shell: step(shell, shellArgs),
  };
  return {
    file: process.execPath,
    args: ['-e', RUN_WRAPPER, Buffer.from(JSON.stringify(plan), 'utf8').toString('base64')],
  };
}

/** A word as Windows programs split command lines, quoted only when it must be. */
function displayWord(word: string): string {
  if (word !== '' && !/[\s"]/.test(word)) return word;
  return `"${word.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
