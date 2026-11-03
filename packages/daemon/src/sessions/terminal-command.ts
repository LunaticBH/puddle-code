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
 * the session shell. POSIX wraps both in `/bin/sh -c`.
 */
export function terminalCommandSpawn(
  command: TerminalCommand,
  shell: string,
  shellArgs: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform === 'win32') {
    // TODO(windows): the Node run wrapper (docs/windows.md decision 13).
    throw new Error('one-shot terminal commands are not yet supported on Windows');
  }
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
