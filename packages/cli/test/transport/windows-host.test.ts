import { describe, expect, it } from 'vitest';
import { LocalTransport } from '../../src/lib/transport/local.js';
import { SshTransport } from '../../src/lib/transport/ssh.js';
import { isWindowsHostFailure, windowsHostRefusal } from '../../src/lib/transport/windows-host.js';

const ssh = new SshTransport('alice@winbox', { platform: 'darwin' });
const failed = (stderr: string, code = 1, stdout = '') => ({ code, stdout, stderr });

describe('SSH to a Windows host is refused clearly', () => {
  it('recognises cmd.exe, PowerShell and Git Bash answers to a POSIX command', () => {
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
  });

  it('leaves ordinary POSIX failures alone', () => {
    expect(
      isWindowsHostFailure(failed('sh: 1: /home/a/.puddle/bin/current/bin/node: not found', 127)),
    ).toBe(false);
    expect(isWindowsHostFailure(failed('puddled install: error: download failed\n'))).toBe(false);
    expect(isWindowsHostFailure({ code: 0, stdout: 'MINGW64_NT', stderr: '' })).toBe(false);
  });

  it('turns a recognised failure into an unsupported-platform error, for SSH transports only', () => {
    const result = failed("'sh' is not recognized as an internal or external command");
    expect(windowsHostRefusal(ssh, result)).toMatchObject({
      code: 'unsupported_platform',
      message: expect.stringContaining('alice@winbox looks like a Windows host'),
    });
    expect(windowsHostRefusal(new LocalTransport({ platform: 'linux' }), result)).toBeNull();
  });
});
