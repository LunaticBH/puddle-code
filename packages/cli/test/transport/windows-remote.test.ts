import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    expect(parseProbe(`${JSON.stringify(answer)}\r\n`)).toEqual({
      ...facts,
      elevatedSupervisor: false,
    });
    expect(
      parseProbe(JSON.stringify({ ...answer, elevatedSupervisor: true }))?.elevatedSupervisor,
    ).toBe(true);
    expect(parseProbe(JSON.stringify({ ...answer, elevatedSupervisor: 'yes' }))).toBeNull();
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
    expect(() => runHelperScript(staged, 'rm -rf', {}, 'current')).toThrow();
    expect(() =>
      runHelperScript({ path: 'C:\\h.mjs', sha256: "'; calc" }, 'install', {}, 'current'),
    ).toThrow();
    expect(() => bootstrapScript({ version: '1; calc', install: {}, helper: staged })).toThrow();
    expect(() =>
      bootstrapScript({ version: '1.2.3', install: {}, helper: staged, slug: 'a/b;c' }),
    ).toThrow();
    expect(() =>
      bootstrapScript({
        op: 'exec' as 'remove',
        version: '1.2.3',
        install: {},
        helper: staged,
        slug: 'a/b',
      }),
    ).toThrow();
  });

  it('checks the staged helper’s digest before every run and before a bootstrap fetches', () => {
    const digest = psQuote(staged.sha256.toUpperCase());
    const run = runHelperScript(staged, 'channel', {}, 'current');
    expect(run).toContain(`Test-PuddleHelper $helper ${digest}`);
    expect(run.indexOf('Test-PuddleHelper')).toBeLessThan(run.indexOf('Invoke-PuddleNode'));
    const boot = bootstrapScript({ version: '1.2.3', install: {}, helper: staged, slug: 'a/b' });
    expect(boot.indexOf('Test-PuddleHelper')).toBeLessThan(boot.indexOf('curl.exe'));
  });
});

/** What a stage reported: the helper's path and the digest it must keep. */
const staged = { path: "C:\\Temp\\O'h.mjs", sha256: 'c'.repeat(64) };

/** Every script the client sends, as one host would receive it. */
function everyScript(): Record<string, string> {
  return {
    probe: windowsScript(PROBE_SCRIPT),
    read: windowsScript(readHomeFileScript('runtime.json')),
    stage: windowsScript(stageScript('windows-host-0123.mjs', 'a'.repeat(64), 10)),
    run: windowsScript(runHelperScript(staged, 'install', { v: 1 }, 'copy')),
    download: windowsScript(
      bootstrapScript({
        version: '1.2.3',
        install: { version: '1.2.3' },
        helper: staged,
        slug: 'acme/puddle',
      }),
      { home: "D:\\puddle's home" },
    ),
    removal: windowsScript(
      bootstrapScript({
        op: 'remove',
        version: '1.2.3',
        install: { purge: true },
        helper: staged,
        slug: 'acme/puddle',
      }),
    ),
    streamed: windowsScript(
      bootstrapScript({
        version: '1.2.3',
        install: { version: '1.2.3' },
        helper: staged,
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

  it('reports a supervisor an elevated session started for as long as it runs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-elevated-'));
    const probeOf = async () => {
      const result = await viaShell('cmd', frame(windowsScript(PROBE_SCRIPT, { home })));
      expect(parseTrailer(result.stderr).code).toBe(0);
      return parseProbe(result.stdout.toString('utf8'))!.elevatedSupervisor;
    };
    expect(await probeOf()).toBe(false);
    // A process standing in for that supervisor: its command line names supervisor.mjs.
    const supervisor = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', 'supervisor.mjs'],
      { stdio: 'ignore', windowsHide: true },
    );
    try {
      await new Promise((resolve) => supervisor.once('spawn', resolve));
      writeFileSync(join(home, 'supervisor-elevated'), `${supervisor.pid}\n`);
      expect(await probeOf()).toBe(true);
      // Any other process holding that number is not it.
      writeFileSync(join(home, 'supervisor-elevated'), `${process.pid}\n`);
      expect(await probeOf()).toBe(false);
    } finally {
      supervisor.kill();
    }
  }, 60_000);

  it('stages the helper and clears what interrupted operations left in %TEMP%', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'puddle-stage-'));
    const dir = join(temp, 'puddle-host');
    mkdirSync(join(dir, 'boot-old'), { recursive: true });
    mkdirSync(join(dir, 'boot-new'));
    for (const name of ['node-old.exe', 'node-new.exe', 'windows-host-1.mjs.part', 'keep.txt']) {
      writeFileSync(join(dir, name), 'x');
    }
    writeFileSync(join(dir, 'boot-old', 'node.exe'), 'x');
    // A day and more old, by creation time: a copy of node.exe keeps its source's write time.
    const age = ['node-old.exe', 'boot-old', 'windows-host-1.mjs.part', 'keep.txt']
      .map(
        (name) =>
          `(Get-Item -LiteralPath ${psQuote(join(dir, name))}).CreationTimeUtc = [DateTime]::UtcNow.AddDays(-2)`,
      )
      .join('\n');
    const body = Buffer.from('helper body');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const script = windowsScript(
      `${age}\n${stageScript('windows-host-1.mjs', sha256, body.length)}`,
    );
    const result = await viaShell('cmd', Buffer.concat([frame(script), body]), {
      ...process.env,
      TEMP: temp,
      TMP: temp,
    });
    expect(parseTrailer(result.stderr)).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout.toString('utf8'))).toEqual({
      path: join(dir, 'windows-host-1.mjs'),
    });
    expect(readFileSync(join(dir, 'windows-host-1.mjs'), 'utf8')).toBe('helper body');
    const left = (name: string) => existsSync(join(dir, name));
    expect(['node-old.exe', 'boot-old', 'windows-host-1.mjs.part'].filter(left)).toEqual([]);
    expect(['node-new.exe', 'boot-new', 'keep.txt'].every(left)).toBe(true);
  }, 60_000);

  /** Run `script` with TEMP pointing at `temp`, its payload after it. */
  const inTemp = (temp: string, script: string, payload: Buffer = Buffer.alloc(0)) =>
    viaShell('cmd', Buffer.concat([frame(windowsScript(script)), payload]), {
      ...process.env,
      TEMP: temp,
      TMP: temp,
    });
  /** The folder's owner, protection and the principals its DACL allows, by SID. */
  const aclOf = (dir: string) => {
    const read = spawnSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$a = Get-Acl -LiteralPath $env:PUDDLE_DIR; $s = [Security.Principal.SecurityIdentifier]; ' +
          '@{ owner = $a.GetOwner($s).Value; protected = $a.AreAccessRulesProtected; ' +
          'allowed = @($a.GetAccessRules($true, $true, $s) | ForEach-Object { $_.IdentityReference.Value }); ' +
          'me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value } | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, PUDDLE_DIR: dir } },
    );
    return JSON.parse(read.stdout) as {
      owner: string;
      protected: boolean;
      allowed: string[];
      me: string;
    };
  };
  const helperBody = Buffer.from('helper body');
  const helperDigest = createHash('sha256').update(helperBody).digest('hex');

  it('stages into a folder only this account can open, whatever TEMP’s own ACL', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'puddle-private-'));
    // As C:\Temp is: every authenticated user may modify what is created in it.
    const grant = spawnSync(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
      [temp, '/grant', '*S-1-5-11:(OI)(CI)M'],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(grant.status, grant.stdout).toBe(0);
    const result = await inTemp(
      temp,
      stageScript('windows-host-1.mjs', helperDigest, helperBody.length),
      helperBody,
    );
    expect(parseTrailer(result.stderr)).toEqual({ code: 0, stderr: '' });
    const acl = aclOf(join(temp, 'puddle-host'));
    expect(acl.owner).toBe(acl.me);
    expect(acl.protected).toBe(true);
    expect(acl.allowed).toEqual([acl.me]);
  }, 60_000);

  it('refuses a staging folder another account could write', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'puddle-shared-'));
    const dir = join(temp, 'puddle-host');
    mkdirSync(dir);
    const grant = spawnSync(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
      [dir, '/grant', '*S-1-5-32-545:(OI)(CI)M'],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(grant.status, grant.stdout).toBe(0);
    const result = await inTemp(
      temp,
      stageScript('windows-host-1.mjs', helperDigest, helperBody.length),
      helperBody,
    );
    expect(parseTrailer(result.stderr)).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('is open to other accounts'),
    });
    expect(existsSync(join(dir, 'windows-host-1.mjs'))).toBe(false);
  }, 60_000);

  it('replaces a copy already staged under the name with the one it received', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'puddle-restage-'));
    const first = await inTemp(
      temp,
      stageScript('windows-host-1.mjs', helperDigest, helperBody.length),
      helperBody,
    );
    expect(parseTrailer(first.stderr).code).toBe(0);
    const dest = join(temp, 'puddle-host', 'windows-host-1.mjs');
    const aged = await inTemp(
      temp,
      `(Get-Item -LiteralPath ${psQuote(dest)}).LastWriteTimeUtc = [DateTime]::UtcNow.AddDays(-3)`,
    );
    expect(parseTrailer(aged.stderr).code).toBe(0);
    const second = await inTemp(
      temp,
      stageScript('windows-host-1.mjs', helperDigest, helperBody.length) +
        `\nWrite-PuddleLine ([string]((Get-Item -LiteralPath ${psQuote(dest)}).LastWriteTimeUtc -gt [DateTime]::UtcNow.AddHours(-1)))`,
      helperBody,
    );
    expect(parseTrailer(second.stderr).code).toBe(0);
    expect(second.stdout.toString('utf8')).toContain('True');
  }, 60_000);

  it('runs a staged helper only while it is still the bytes staged', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'puddle-digest-'));
    const stage = await inTemp(
      temp,
      stageScript('windows-host-1.mjs', helperDigest, helperBody.length),
      helperBody,
    );
    const path = (JSON.parse(stage.stdout.toString('utf8')) as { path: string }).path;
    const helper = { path, sha256: helperDigest };
    const home = `$env:PUDDLE_HOME = ${psQuote(join(temp, 'no-home'))}\n`;
    // Intact, it gets as far as the missing runtime (4).
    const intact = await inTemp(temp, home + runHelperScript(helper, 'inspect', {}, 'current'));
    expect(parseTrailer(intact.stderr).code).toBe(4);
    // Rewritten, it is never run: the client stages it again (3).
    writeFileSync(path, 'process.exit(0) // someone else’s code');
    const rewritten = await inTemp(temp, home + runHelperScript(helper, 'inspect', {}, 'current'));
    expect(parseTrailer(rewritten.stderr).code).toBe(3);
    // Nor does a bootstrap fetch anything for it.
    const boot = await inTemp(
      temp,
      bootstrapScript({ version: '1.2.3', install: {}, helper, slug: 'acme/puddle' }),
    );
    expect(parseTrailer(boot.stderr)).toEqual({ code: 3, stderr: '' });
  }, 60_000);

  it('refuses a frame that is cut short', async () => {
    const result = await viaShell('direct', frame('$x = 1').subarray(0, 12));
    expect(parseTrailer(result.stderr)).toEqual({
      code: 1,
      stderr: 'puddle-host: the script frame ended early',
    });
  }, 60_000);
});
