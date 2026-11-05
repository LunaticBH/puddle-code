import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFakeExecutable } from '../../../daemon/test/helpers/fake-executable.js';

/** The Node stand-in for the system ssh binary (see fake-ssh.mjs). */
export const FAKE_SSH_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'fake-ssh.mjs');

/**
 * A runnable fake ssh. POSIX executes the script through its shebang;
 * Windows cannot run a script directly, so it gets an npm-style `ssh.cmd`
 * shim, which the transport unwraps to `node fake-ssh` like any npm command.
 */
export function fakeSshBinary(): string {
  if (process.platform !== 'win32') {
    chmodSync(FAKE_SSH_SCRIPT, 0o755);
    return FAKE_SSH_SCRIPT;
  }
  const dir = mkdtempSync(join(tmpdir(), 'puddle-fake-ssh-'));
  return writeFakeExecutable(dir, 'ssh', readFileSync(FAKE_SSH_SCRIPT, 'utf8'));
}

/** The Node stand-in for ssh to a Windows OpenSSH server (see fake-windows-ssh.mjs). */
export const FAKE_WINDOWS_SSH_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  'fake-windows-ssh.mjs',
);

/**
 * A runnable fake ssh to a Windows host, as `<dir>\ssh.cmd` (npm's shim,
 * which SshTransport unwraps to `node fake-windows-ssh`), with its scp
 * beside it as `<dir>\scp.cmd`: pass it as the transport's sshBinary, or put
 * `dir` first on a CLI process's PATH. Windows only, since its "host" is
 * this machine's cmd.exe, PowerShell or Git Bash.
 */
export function fakeWindowsSshBinary(dir = mkdtempSync(join(tmpdir(), 'puddle-fake-winssh-'))) {
  const source = readFileSync(FAKE_WINDOWS_SSH_SCRIPT, 'utf8');
  writeFakeExecutable(dir, 'scp', source);
  return writeFakeExecutable(dir, 'ssh', source);
}
