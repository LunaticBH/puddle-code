import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  b64json,
  bootstrapScript,
  frame,
  fromB64json,
  languageModeRefusal,
  parseProbe,
  parseTrailer,
  PROBE_SCRIPT,
  psQuote,
  readHomeFileScript,
  runHelperScript,
  stageScript,
  WINDOWS_LOADER,
  windowsRemoteCommand,
  windowsScript,
} from '../../src/lib/transport/windows-remote.js';

/**
 * The PowerShell primitive every Windows SSH host operation rides on
 * (docs/windows.md): its command line, framing and trailer everywhere, and
 * on Windows the loader itself under each default shell OpenSSH may use.
 */

describe('the Windows remote command', () => {
  it('fits cmd.exe’s command line and holds nothing a shell could reinterpret', () => {
    const command = windowsRemoteCommand();
    // cmd.exe /c with its own name in front must stay under 8191 characters.
    expect(`cmd.exe /c ${command}`.length).toBeLessThan(8191);
    const encoded = command.split(' ').at(-1)!;
    expect(command).toBe(
      `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
    );
    // No padding (MSYS reads `x=/y` as an assignment), no shell metacharacters.
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+$/);
    expect(Buffer.from(encoded, 'base64').toString('utf16le').trimEnd()).toBe(WINDOWS_LOADER);
  });

  it('frames a script by its UTF-8 length', () => {
    const framed = frame('Write-Output "é"');
    const header = framed.subarray(0, framed.indexOf(10) + 1).toString('ascii');
    expect(header).toBe(`PUDDLE1 ${Buffer.byteLength('Write-Output "é"')}\n`);
    expect(framed.subarray(header.length).toString('utf8')).toBe('Write-Output "é"');
  });

  it('takes the script’s own status from the trailer, whatever the shell reported', () => {
    expect(parseTrailer('warning\npuddle-exit:42\n')).toEqual({ code: 42, stderr: 'warning' });
    expect(parseTrailer('puddle-exit:0\n')).toEqual({ code: 0, stderr: '' });
    expect(parseTrailer('puddle-host: boom\npuddle-exit:1')).toEqual({
      code: 1,
      stderr: 'puddle-host: boom',
    });
    // No trailer: the loader never finished (no PowerShell, a dropped connection).
    expect(parseTrailer("'powershell.exe' is not recognized\r\n")).toEqual({
      code: null,
      stderr: "'powershell.exe' is not recognized\r\n",
    });
    // Only the last line counts.
    expect(parseTrailer('puddle-exit:3\nlater').code).toBeNull();
  });

  it('quotes PowerShell literals and carries values as base64 JSON', () => {
    expect(psQuote("C:\\Users\\O'Brien")).toBe("'C:\\Users\\O''Brien'");
    // PowerShell treats typographic single quotes as quotes too.
    expect(psQuote('a\u2019b')).toBe("'a\u2019\u2019b'");
    const value = { profile: 'x', path: 'C:\\a "b"\\c', n: 1 };
    expect(b64json(value)).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(fromB64json(b64json(value))).toEqual(value);
    expect(fromB64json(undefined)).toEqual({});
  });

  it('accepts only a probe answer a Windows host gives', () => {
    const answer = {
      puddle: 'windows-host',
      home: 'C:\\Users\\a\\.puddle',
      current: 'C:\\Users\\a\\.puddle\\bin\\versions\\0.3.14',
      node: 'x64',
      arch: 'x64',
      build: 26200,
      elevated: false,
      temp: 'C:\\Users\\a\\AppData\\Local\\Temp\\',
    };
    const { puddle: _marker, ...facts } = answer;
    expect(parseProbe(`${JSON.stringify(answer)}\r\n`)).toEqual(facts);
    expect(parseProbe(JSON.stringify({ ...answer, current: null, node: null }))).toMatchObject({
      current: null,
      node: null,
    });
    expect(parseProbe(JSON.stringify({ ...answer, puddle: 'other' }))).toBeNull();
    expect(parseProbe(JSON.stringify({ ...answer, elevated: 'no' }))).toBeNull();
    expect(parseProbe('sh: powershell.exe: command not found')).toBeNull();
    expect(parseProbe('{not json')).toBeNull();
  });

  it('recognises a constrained PowerShell session and nothing else', () => {
    expect(
      languageModeRefusal('a@w', 'puddle-host: puddle-language-mode:ConstrainedLanguage'),
    ).toMatchObject({ code: 'unsupported_platform' });
    expect(
      languageModeRefusal(
        'a@w',
        'Cannot invoke method. Method invocation is supported only on core types in this language mode.',
      ),
    ).toMatchObject({ message: expect.stringContaining('ConstrainedLanguage') });
    expect(languageModeRefusal('a@w', 'puddle-host: download failed')).toBeNull();
  });

  it('refuses values a script would have to interpret', () => {
    expect(() => readHomeFileScript('..\\secrets')).toThrow();
    expect(() => stageScript('x;y', 'a'.repeat(64), 1)).toThrow();
    expect(() => runHelperScript('C:\\h.mjs', 'rm -rf', {}, 'current')).toThrow();
    expect(() =>
      bootstrapScript({ version: '1; calc', install: {}, helper: 'C:\\h.mjs' }),
    ).toThrow();
    expect(() =>
      bootstrapScript({ version: '1.2.3', install: {}, helper: 'h', slug: 'a/b;c' }),
    ).toThrow();
  });
});

/** Every script the client sends, as one host would receive it. */
function everyScript(): Record<string, string> {
  return {
    probe: windowsScript(PROBE_SCRIPT),
    read: windowsScript(readHomeFileScript('runtime.json')),
    stage: windowsScript(stageScript('windows-host-0123.mjs', 'a'.repeat(64), 10)),
    run: windowsScript(runHelperScript("C:\\Temp\\O'h.mjs", 'install', { v: 1 }, 'copy')),
    download: windowsScript(
      bootstrapScript({
        version: '1.2.3',
        install: { version: '1.2.3' },
        helper: 'C:\\h.mjs',
        slug: 'acme/puddle',
      }),
      { home: "D:\\puddle's home" },
    ),
    streamed: windowsScript(
      bootstrapScript({
        version: '1.2.3',
        install: { version: '1.2.3' },
        helper: 'C:\\h.mjs',
        archive: {
          name: 'puddled-v1.2.3-win32-x64.zip',
          length: 10,
          sha256: 'b'.repeat(64),
          verified: true,
        },
      }),
    ),
  };
}

const powershell = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

/** Run the loader as the server's default shell would, with `input` on standard input. */
function viaShell(
  shell: 'direct' | 'cmd' | 'powershell',
  input: Buffer,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const command = windowsRemoteCommand();
  const [file, args, verbatim] =
    shell === 'direct'
      ? [powershell, command.split(' ').slice(1), false]
      : shell === 'cmd'
        ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], true]
        : [powershell, ['-NoProfile', '-c', command], false];
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      env,
    });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.on('error', () => {});
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr }));
    child.stdin.end(input);
  });
}

describe.runIf(process.platform === 'win32')('the loader on Windows', () => {
  it('parses every script the client sends', () => {
    const scripts = everyScript();
    const probe = spawnSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$failed = @(); foreach ($name in $env:PUDDLE_SCRIPT_NAMES.Split(",")) { $errors = $null; ' +
          '[void][Management.Automation.Language.Parser]::ParseInput([Environment]::GetEnvironmentVariable("PUDDLE_SCRIPT_" + $name), [ref]$null, [ref]$errors); ' +
          'if ($errors.Count) { $failed += "${name}: $($errors[0].Message)" } }; $failed -join "; "',
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          PUDDLE_SCRIPT_NAMES: Object.keys(scripts).join(','),
          ...Object.fromEntries(
            Object.entries(scripts).map(([name, text]) => [`PUDDLE_SCRIPT_${name}`, text]),
          ),
        },
      },
    );
    expect(probe.stdout.trim()).toBe('');
    expect(probe.status).toBe(0);
  });

  const payload = Buffer.concat([
    Buffer.from([0, 0xff, 13, 10, 0x1a, 0x80]),
    Buffer.from('héllo ✓ \r\n end'),
    Buffer.alloc(150_000, 0xab),
  ]);
  // Copies its payload through a node.exe that inherits the connection's own
  // standard handles, as every helper operation runs.
  const relay = windowsScript(
    `$global:PuddleExit = Invoke-PuddleNode ${psQuote(process.execPath)} @('-e', ${psQuote(
      "process.stdin.pipe(process.stdout); process.stdin.on('end', () => { process.stderr.write('note\\n'); process.exitCode = 7 })",
    )})\n'stray pipeline output'`,
  );

  for (const shell of ['direct', 'cmd', 'powershell'] as const) {
    it(`passes bytes through unchanged and reports the real status (${shell})`, async () => {
      const result = await viaShell(shell, Buffer.concat([frame(relay), payload]));
      expect(result.stdout.equals(payload)).toBe(true);
      expect(parseTrailer(result.stderr)).toEqual({ code: 7, stderr: 'note' });
      // A PowerShell default shell reports any failure as 1.
      expect(result.code).toBe(shell === 'powershell' ? 1 : 7);
    }, 60_000);

    it(`reports a failed script as plain text (${shell})`, async () => {
      const result = await viaShell(shell, frame(windowsScript("throw 'nothing to do ✓'")));
      expect(result.stderr).not.toContain('CLIXML');
      expect(parseTrailer(result.stderr)).toEqual({
        code: 1,
        stderr: 'puddle-host: nothing to do ✓',
      });
    }, 60_000);
  }

  it('applies a home override and answers the probe', async () => {
    const result = await viaShell(
      'cmd',
      frame(windowsScript(PROBE_SCRIPT, { home: "C:\\no such\\O'Brien home" })),
    );
    expect(parseTrailer(result.stderr).code).toBe(0);
    const probe = parseProbe(result.stdout.toString('utf8'));
    expect(probe).toMatchObject({
      home: "C:\\no such\\O'Brien home",
      current: null,
      node: null,
      arch: expect.stringMatching(/^(x64|arm64)$/),
    });
  }, 60_000);

  it('refuses a frame that is cut short', async () => {
    const result = await viaShell('direct', frame('$x = 1').subarray(0, 12));
    expect(parseTrailer(result.stderr)).toEqual({
      code: 1,
      stderr: 'puddle-host: the script frame ended early',
    });
  }, 60_000);
});
