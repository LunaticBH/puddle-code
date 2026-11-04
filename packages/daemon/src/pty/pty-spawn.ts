import { resolveSpawn, setEnv, type Environment } from '@puddle/shared/node/platform';

/**
 * What PtyManager hands node-pty for one spawn. POSIX is the long-standing
 * `{ ...base, ...overrides }` with the file and argv untouched; node-pty's
 * spawn-helper then execvp's the file with the child environment's PATH.
 *
 * Windows needs three corrections (docs/windows.md, decisions 9 and 10):
 * - node-pty (ConPTY, verified with node-pty 1.1.0) looks only for the exact
 *   file name and never consults PATHEXT, so `claude` (claude.exe) and
 *   npm's `codex.cmd` both fail with "File not found". `resolveSpawn` finds
 *   the executable on the child's own Path and unwraps npm-style shims into
 *   `node.exe <script>`, so a prompt never passes through cmd.exe;
 * - environment keys are case-insensitive, and node-pty passes duplicate
 *   spellings (`Path` and `PATH`) straight into CreateProcess, which honours
 *   the first one. Overrides are therefore applied with `setEnv`;
 * - node-pty quotes an argv itself, but leaves an argument that already
 *   starts and ends with `"` unquoted and so loses its quotes. The command
 *   line is built here instead, following the Microsoft C runtime rules that
 *   node.exe, PowerShell and Git Bash all parse with. A line CreateProcess
 *   would refuse is refused here, with its length, rather than with
 *   node-pty's bare "error code: 206".
 *
 * node-pty sets `TERM` to the terminal name only on Unix; Windows children get
 * the same value here, for TERM-sniffing CLIs and MSYS tools.
 */
export interface PtySpawnPlan {
  file: string;
  /** An argv on POSIX; a complete Windows command line (after the file) on win32. */
  args: string[] | string;
  env: Record<string, string>;
}

/** CreateProcess's command-line limit, counting the terminating NUL. */
export const WINDOWS_COMMAND_LINE_LIMIT = 32_767;

/** A Windows command line too long for CreateProcess, which would fail with error 206. */
export class WindowsCommandLineTooLongError extends Error {
  constructor(readonly length: number) {
    super(
      `the command line is ${length.toLocaleString('en-GB')} characters long, ` +
        `but Windows allows at most ${(WINDOWS_COMMAND_LINE_LIMIT - 1).toLocaleString('en-GB')}`,
    );
    this.name = 'WindowsCommandLineTooLongError';
  }
}

export function planPtySpawn(
  file: string,
  args: readonly string[],
  overrides: Record<string, string> | undefined,
  opts: { platform?: NodeJS.Platform; base?: Environment } = {},
): PtySpawnPlan {
  const platform = opts.platform ?? process.platform;
  const base = opts.base ?? process.env;
  if (platform !== 'win32') {
    return { file, args: [...args], env: { ...base, ...overrides } as Record<string, string> };
  }
  const env: Environment = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  for (const [key, value] of Object.entries(overrides ?? {})) setEnv(env, key, value, platform);
  setEnv(env, 'TERM', 'xterm-256color', platform);
  const resolved = resolveSpawn(file, args, { platform, env });
  for (const [key, value] of Object.entries(resolved.env ?? {})) setEnv(env, key, value, platform);
  const tail = windowsCommandLine(resolved.args, resolved.windowsVerbatimArguments === true);
  // node-pty hands CreateProcess the file, quoted as here, a space and the tail.
  const length = quoteWindowsArgument(resolved.file).length + 1 + tail.length;
  if (length >= WINDOWS_COMMAND_LINE_LIMIT) throw new WindowsCommandLineTooLongError(length);
  return { file: resolved.file, args: tail, env: env as Record<string, string> };
}

/**
 * The command-line tail for `args`: each argument quoted as libuv quotes it for
 * `child_process` (CommandLineToArgvW / C runtime conventions), or, for an
 * already-quoted cmd.exe line, joined verbatim.
 */
export function windowsCommandLine(args: readonly string[], verbatim = false): string {
  return args.map((arg) => (verbatim ? arg : quoteWindowsArgument(arg))).join(' ');
}

/**
 * One argument in C runtime quoting: bare when it has no space, tab or quote;
 * otherwise wrapped in quotes, with each embedded quote and the backslashes
 * before it (or before the closing quote) escaped.
 */
export function quoteWindowsArgument(arg: string): string {
  if (arg === '') return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  let quoted = '"';
  let backslashes = 0;
  for (const character of arg) {
    if (character === '\\') {
      backslashes++;
      continue;
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += '\\'.repeat(backslashes) + character;
    }
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}
