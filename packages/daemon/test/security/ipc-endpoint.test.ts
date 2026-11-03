import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkIpcEndpoint } from '@puddle/shared/node';

describe('IPC endpoint checks before connecting', () => {
  it('never stats a Windows pipe, which would open it as a client', () => {
    // A path that does not exist would throw ENOENT if it were stat'ed.
    expect(() => checkIpcEndpoint('\\\\.\\pipe\\puddle-absent', 'win32')).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'keeps checking POSIX sockets as private files (Unix modes)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'puddle-ipc-endpoint-'));
      const path = join(dir, 'control.sock');
      expect(() => checkIpcEndpoint(path, 'linux')).toThrow(
        expect.objectContaining({ code: 'ENOENT' }),
      );
      writeFileSync(path, '');
      chmodSync(path, 0o644);
      expect(() => checkIpcEndpoint(path, 'linux')).toThrow('must be private');
      chmodSync(path, 0o600);
      expect(() => checkIpcEndpoint(path, 'linux')).not.toThrow();
    },
  );
});
