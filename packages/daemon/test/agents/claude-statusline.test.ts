import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execPath } from 'node:process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { system32Path } from '@puddle/shared/node/platform';
import {
  claudeStatusLineCommand,
  runsStatusLineHelper,
} from '../../src/agents/claude-code/hook-command.js';
import { installStatusLine, readLiveUsage } from '../../src/agents/claude-code/statusline.js';

/** The PowerShell text inside a status line's `-EncodedCommand`. */
function encodedScript(command: string): string {
  const encoded = /-EncodedCommand (\S+)$/.exec(command)?.[1] ?? '';
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

const windows = process.platform === 'win32';
const windowsPowerShell = system32Path('WindowsPowerShell\\v1.0\\powershell.exe');

describe('claude-code status line capture', () => {
  it('installs a statusLine command without clobbering an existing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-sl-'));
    installStatusLine(dir);
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
      statusLine?: { command: string };
    };
    expect(settings.statusLine?.command).toContain('puddle-statusline.mjs');

    // A user-defined status line is respected on re-install.
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }),
    );
    installStatusLine(dir);
    const after = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
      statusLine?: { command: string };
    };
    expect(after.statusLine?.command).toBe('mine');
  });

  it('the helper records the fields puddle surfaces and prints a status line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-sl-'));
    installStatusLine(dir);
    expect(readLiveUsage(dir)).toBeNull(); // nothing captured yet

    // Feed the helper a real-shaped payload exactly as Claude Code would.
    const payload = JSON.stringify({
      context_window: { used_percentage: 42.7 },
      cost: { total_cost_usd: 0 },
      model: { display_name: 'Fable 5' },
    });
    const line = execFileSync(execPath, [join(dir, 'puddle-statusline.mjs')], {
      input: payload,
      encoding: 'utf8',
    });
    expect(line).toContain('Fable 5');
    expect(line).toContain('43%'); // rounded

    const usage = readLiveUsage(dir);
    expect(usage?.context_used_percentage).toBe(42.7);
    expect(usage?.model).toBe('Fable 5');
    expect(typeof usage?.captured_at).toBe('string');
  });

  it('keeps the POSIX command and writes one no Windows shell interprets', () => {
    const script = 'C:\\Users\\O’Neil $x\\cfg\\puddle-statusline.mjs';
    const node = 'C:\\Users\\a\\.puddle\\bin\\versions\\0.3.14\\bin\\node.exe';
    const env = { SystemRoot: 'C:\\WINDOWS' };
    expect(claudeStatusLineCommand(script, 'linux')).toBe(
      `${JSON.stringify(execPath)} ${JSON.stringify(script)}`,
    );
    expect(claudeStatusLineCommand('/home/a/.claude/puddle-statusline.mjs', 'darwin', node)).toBe(
      `${JSON.stringify(node)} "/home/a/.claude/puddle-statusline.mjs"`,
    );
    // Only characters no shell treats specially: both paths bare, with `/`.
    expect(
      claudeStatusLineCommand('C:\\Users\\a\\.claude\\puddle-statusline.mjs', 'win32', node, env),
    ).toBe(
      'C:/Users/a/.puddle/bin/versions/0.3.14/bin/node.exe C:/Users/a/.claude/puddle-statusline.mjs',
    );
    // Anything else runs from base64 through Windows PowerShell.
    const encoded = claudeStatusLineCommand(script, 'win32', node, env);
    expect(encoded).toMatch(
      /^C:\/WINDOWS\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/]+={0,2}$/,
    );
    expect(encodedScript(encoded)).toBe(
      `& '${node}' 'C:\\Users\\O’’Neil $x\\cfg\\puddle-statusline.mjs'`,
    );
    const spacedNode = 'C:\\Program Files\\nodejs\\node.exe';
    const unusualRoot = claudeStatusLineCommand(
      'C:\\cfg\\puddle-statusline.mjs',
      'win32',
      spacedNode,
      {
        SystemRoot: 'D:\\Win Dir',
      },
    );
    expect(unusualRoot).toMatch(
      /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand /,
    );
    expect(encodedScript(unusualRoot)).toBe(`& '${spacedNode}' 'C:\\cfg\\puddle-statusline.mjs'`);
    // Puddle recognises its own line in either form, and no other.
    const file = 'puddle-statusline.mjs';
    expect(runsStatusLineHelper({ type: 'command', command: encoded }, file)).toBe(true);
    expect(runsStatusLineHelper({ type: 'command', command: `node C:/x/${file}` }, file)).toBe(
      true,
    );
    expect(runsStatusLineHelper({ type: 'command', command: 'mine' }, file)).toBe(false);
    expect(
      runsStatusLineHelper(
        { type: 'command', command: `powershell.exe -EncodedCommand ${btoa('mine')}` },
        file,
      ),
    ).toBe(false);
    expect(runsStatusLineHelper(null, file)).toBe(false);
  });

  it('rewrites its own line on Windows but still respects a user line', () => {
    const dir = mkdtempSync(join(tmpdir(), "puddle-sl O'Neil $x-"));
    const settingsFile = join(dir, 'settings.json');
    const read = () =>
      JSON.parse(readFileSync(settingsFile, 'utf8')) as { statusLine: { command: string } };
    const current = claudeStatusLineCommand(join(dir, 'puddle-statusline.mjs'), 'win32');
    installStatusLine(dir, 'linux');
    installStatusLine(dir, 'win32');
    expect(read().statusLine.command).toBe(current);
    // A line naming an earlier release's node, encoded too, is ours and replaced.
    const stale = claudeStatusLineCommand(
      join(dir, 'puddle-statusline.mjs'),
      'win32',
      "C:\\Users\\O'Neil\\.puddle\\bin\\versions\\0.3.13\\bin\\node.exe",
    );
    expect(stale).not.toBe(current);
    writeFileSync(
      settingsFile,
      JSON.stringify({ statusLine: { type: 'command', command: stale } }),
    );
    installStatusLine(dir, 'win32');
    expect(read().statusLine.command).toBe(current);
    writeFileSync(
      settingsFile,
      JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }),
    );
    installStatusLine(dir, 'win32');
    expect(read().statusLine.command).toBe('mine');
  });

  // Claude Code runs a Windows status line through Git Bash when it finds one,
  // else through `powershell -NoProfile -NonInteractive -ExecutionPolicy
  // Bypass -Command`; cmd.exe is covered for a future Claude using it. No
  // test runs Git Bash, which Puddle never needs.
  it.runIf(windows)('runs the Windows status line under PowerShell and cmd.exe', () => {
    const payload = JSON.stringify({
      context_window: { used_percentage: 12 },
      cost: { total_cost_usd: 0 },
      model: { display_name: 'Fable 5' },
      padding: 'x'.repeat(5 * 1024),
    });
    const shells = (command: string): Array<[string, string[]]> => [
      [
        windowsPowerShell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      ],
      [system32Path('cmd.exe'), ['/d', '/s', '/c', command]],
    ];
    const plain = mkdtempSync(join(tmpdir(), 'puddle-sl-plain-'));
    const unusual = mkdtempSync(join(tmpdir(), "puddle-sl O'Neil Zoë’s $x [y] 100%-"));
    try {
      for (const dir of [plain, unusual]) {
        installStatusLine(dir, 'win32');
        const { command } = (
          JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
            statusLine: { command: string };
          }
        ).statusLine;
        if (dir === unusual) expect(command).toContain('-EncodedCommand');
        for (const [shell, args] of shells(command)) {
          rmSync(join(dir, 'puddle-status.json'), { force: true });
          const line = execFileSync(shell, args, {
            input: payload,
            encoding: 'utf8',
            windowsHide: true,
          });
          expect(line, `${shell} ${command}`).toBe('Fable 5  ctx 12%');
          expect(readLiveUsage(dir)?.context_used_percentage).toBe(12);
        }
      }
    } finally {
      rmSync(plain, { recursive: true, force: true });
      rmSync(unusual, { recursive: true, force: true });
    }
  });

  it('tolerates a malformed payload without writing junk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-sl-'));
    installStatusLine(dir);
    const line = execFileSync(execPath, [join(dir, 'puddle-statusline.mjs')], {
      input: 'not json',
      encoding: 'utf8',
    });
    expect(line).toBe('');
    expect(existsSync(join(dir, 'puddle-status.json'))).toBe(false);
  });
});
