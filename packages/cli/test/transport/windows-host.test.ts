import { describe, expect, it } from 'vitest';
import { isWindowsHostFailure } from '../../src/lib/transport/windows-host.js';

const failed = (stderr: string, code = 1, stdout = '') => ({ code, stdout, stderr });

describe('how a Windows host answers a POSIX command', () => {
  it('recognises cmd.exe, PowerShell, Git Bash and a Windows node.exe', () => {
    expect(
      isWindowsHostFailure(
        failed(
          "'sh' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n",
        ),
      ),
    ).toBe(true);
    // cmd.exe's own status for an unknown command, whatever the display language.
    expect(isWindowsHostFailure(failed('Der Befehl "sh" ist falsch geschrieben', 9009))).toBe(true);
    expect(
      isWindowsHostFailure(
        failed(
          "sh : The term 'sh' is not recognized as the name of a cmdlet\r\n" +
            '    + FullyQualifiedErrorId : CommandNotFoundException\r\n',
        ),
      ),
    ).toBe(true);
    expect(
      isWindowsHostFailure(
        failed(
          'puddled install: error: unsupported OS MINGW64_NT-10.0-26200 (linux and darwin only)\n',
        ),
      ),
    ).toBe(true);
    expect(isWindowsHostFailure(failed('', 1, 'MSYS_NT-10.0-26200\n'))).toBe(true);
    // The POSIX helper stage, run by a Git Bash default shell's node.exe.
    expect(
      isWindowsHostFailure(failed('TypeError: process.getuid is not a function\n    at [eval]:4')),
    ).toBe(true);
  });

  it('leaves ordinary POSIX failures alone', () => {
    expect(
      isWindowsHostFailure(failed('sh: 1: /home/a/.puddle/bin/current/bin/node: not found', 127)),
    ).toBe(false);
    expect(isWindowsHostFailure(failed('puddled install: error: download failed\n'))).toBe(false);
    expect(isWindowsHostFailure({ code: 0, stdout: 'MINGW64_NT', stderr: '' })).toBe(false);
  });
});
