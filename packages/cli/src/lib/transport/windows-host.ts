import type { ExecResult } from './transport.js';

/**
 * How a Windows host gives itself away when it is sent a POSIX command
 * (docs/windows.md, decision 4): cmd.exe's "not recognized" (status 9009),
 * PowerShell's CommandNotFoundException (both shells' default for Windows
 * OpenSSH), install.sh naming a Git Bash, MSYS or Cygwin kernel, or the
 * POSIX helper stage run by a Windows node.exe (a Git Bash default shell,
 * which passes `true`). SshTransport confirms a match with its PowerShell
 * probe before treating the host as Windows.
 */
const WINDOWS_SIGNATURES = [
  /is not recognized as an internal or external command/i,
  /CommandNotFoundException/,
  /\b(?:MINGW(?:32|64)|MSYS|CYGWIN)_NT/,
  /process\.getuid is not a function/,
];

export function isWindowsHostFailure(result: ExecResult): boolean {
  if (result.code === 0) return false;
  if (result.code === 9009) return true;
  const output = `${result.stderr}\n${result.stdout}`;
  return WINDOWS_SIGNATURES.some((signature) => signature.test(output));
}
