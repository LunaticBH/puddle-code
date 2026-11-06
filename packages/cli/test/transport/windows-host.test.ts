import { describe, expect, it } from 'vitest';
import { isWindowsHostFailure, ProbeStderrRelay } from '../../src/lib/transport/windows-host.js';
import {
  CMD_TRUE_ANSWER,
  HOST_KEY_WARNING,
  POWERSHELL_TRUE_ANSWER,
  PWSH_TRUE_ANSWER,
} from '../helpers/windows-true-answers.js';

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

/** A relay fed `text` in pieces of `size` bytes; what it passed on before and after `end(windows)`. */
function relay(text: string, windows: boolean, size = Infinity) {
  const out: Buffer[] = [];
  const relayed = new ProbeStderrRelay((chunk) => out.push(Buffer.from(chunk)));
  const bytes = Buffer.from(text, 'utf8');
  const step = Math.min(size, bytes.length);
  for (let i = 0; i < bytes.length; i += step) relayed.write(bytes.subarray(i, i + step));
  const before = Buffer.concat(out).toString('utf8');
  relayed.end(windows);
  return { before, after: Buffer.concat(out).toString('utf8') };
}

describe('the `true` probe’s standard error on a Windows client', () => {
  for (const [shell, answer] of [
    ['cmd.exe', CMD_TRUE_ANSWER],
    ['Windows PowerShell', POWERSHELL_TRUE_ANSWER],
    ['PowerShell 7', PWSH_TRUE_ANSWER],
  ] as const) {
    for (const size of [Infinity, 1, 7]) {
      it(`leaves out ${shell}'s answer on a Windows host, keeping the rest (pieces of ${size})`, () => {
        const verbose = 'Transferred: sent 2332, received 2096 bytes, in 0.3 seconds\r\n';
        const { before, after } = relay(HOST_KEY_WARNING + answer + verbose, true, size);
        // Passed on at once: everything before the answer.
        expect(before).toBe(HOST_KEY_WARNING);
        expect(after).toBe(HOST_KEY_WARNING + verbose);
      });
    }
  }

  it('passes a POSIX host’s standard error byte for byte, as it arrives', () => {
    const banner = Buffer.concat([
      Buffer.from("Authorised users only.\n'quoted' line\n\ttrue story\n", 'utf8'),
      Buffer.from([0xe2, 0x80, 0x94, 0xff, 0x0a]), // UTF-8 and a stray byte
      Buffer.from('no newline at the end', 'utf8'),
    ]);
    const out: Buffer[] = [];
    const relayed = new ProbeStderrRelay((chunk) => out.push(Buffer.from(chunk)));
    relayed.write(banner);
    // Not one byte waits: no line could begin a Windows shell's answer.
    expect(Buffer.concat(out).equals(banner)).toBe(true);
    relayed.end(false);
    expect(Buffer.concat(out).equals(banner)).toBe(true);
  });

  it('holds back only a line that could still begin the answer, and only until it cannot', () => {
    const out: string[] = [];
    const relayed = new ProbeStderrRelay((chunk) => out.push(chunk.toString()));
    relayed.write(Buffer.from("x\r\n'true"));
    expect(out.join('')).toBe('x\r\n');
    relayed.write(Buffer.from("' and 'false'\r\n"));
    expect(out.join('')).toBe("x\r\n'true' and 'false'\r\n");
    // A last line that never finished is passed on at the end.
    relayed.write(Buffer.from('true :'));
    relayed.end(false);
    expect(out.join('')).toBe("x\r\n'true' and 'false'\r\ntrue :");
  });

  it('keeps everything when the host did not prove to be Windows', () => {
    expect(relay(HOST_KEY_WARNING + CMD_TRUE_ANSWER, false).after).toBe(
      HOST_KEY_WARNING + CMD_TRUE_ANSWER,
    );
    expect(relay(POWERSHELL_TRUE_ANSWER, false, 3).after).toBe(POWERSHELL_TRUE_ANSWER);
  });

  it('keeps an answer that is not exactly a Windows shell’s', () => {
    // Localised, cut short, or followed by something other than its own lines.
    const german =
      'Der Befehl "true" ist entweder falsch geschrieben oder\r\nkonnte nicht gefunden werden.\r\n';
    expect(relay(german, true).after).toBe(german);
    const cut = "'true' is not recognized as an internal or external command,\r\n";
    expect(relay(cut, true).after).toBe(cut);
    const odd = `${POWERSHELL_TRUE_ANSWER.split('    + FullyQualifiedErrorId')[0]}something else\r\n`;
    expect(relay(odd, true).after).toBe(odd);
  });

  it('passes anything that arrives after the decision straight through', () => {
    const out: string[] = [];
    const relayed = new ProbeStderrRelay((chunk) => out.push(chunk.toString()));
    relayed.end(true);
    relayed.write(Buffer.from(CMD_TRUE_ANSWER));
    expect(out.join('')).toBe(CMD_TRUE_ANSWER);
  });
});
