import type { ExecResult, Transport } from './transport.js';
import { CliError } from '../types.js';

/**
 * SSH to a Windows host is unsupported in v1 (docs/windows.md): every remote
 * command assumes a POSIX `sh`. Rather than probe each host with an extra
 * command, a failed remote command is recognised by how Windows reports it:
 * cmd.exe's "not recognized" (exit status 9009), PowerShell's
 * CommandNotFoundException (both shells' default for Windows OpenSSH), or
 * install.sh naming a Git Bash, MSYS or Cygwin kernel.
 */
const WINDOWS_SIGNATURES = [
  /is not recognized as an internal or external command/i,
  /CommandNotFoundException/,
  /\b(?:MINGW(?:32|64)|MSYS|CYGWIN)_NT/,
];

export function isWindowsHostFailure(result: ExecResult): boolean {
  if (result.code === 0) return false;
  if (result.code === 9009) return true;
  const output = `${result.stderr}\n${result.stdout}`;
  return WINDOWS_SIGNATURES.some((signature) => signature.test(output));
}

/** The error for a remote command that failed because its host runs Windows; null otherwise. */
export function windowsHostRefusal(transport: Transport, result: ExecResult): CliError | null {
  if (transport.kind !== 'ssh' || !isWindowsHostFailure(result)) return null;
  return new CliError(
    'unsupported_platform',
    `${transport.label} looks like a Windows host, and SSH to Windows hosts is not supported yet`,
    'run puddle launch on that machine itself, or connect to a Linux or macOS host',
  );
}
