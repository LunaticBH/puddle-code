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
