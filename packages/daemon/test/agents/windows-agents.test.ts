import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { isPidAlive } from '@puddle/shared/node/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrubbedEnv } from '../../src/agents/claude-code/usage-cli.js';
import { codexThreadIndex } from '../../src/agents/codex/threads.js';
import { stopProcess } from '../../src/agents/codex/lifecycle.js';
import { geminiHookCommand } from '../../src/agents/gemini-cli/hook-command.js';
import { installGeminiLifecycleHooks } from '../../src/agents/gemini-cli/hooks.js';
import { lifecycleVersionAtLeast } from '../../src/agents/lifecycle-version.js';
import { sameNativeCwd } from '../../src/agents/native-cwd.js';
import { matchesAgentProcess, windowsArgv } from '../../src/agents/process-match.js';
import { gitBashPathLiteral, powershellLiteral } from '../../src/agents/shell-quote.js';
import { waitFor } from '../helpers/daemon-fixtures.js';

afterEach(() => vi.useRealTimers());

describe('native cwd identity', () => {
  it('is exact on POSIX', () => {
    expect(sameNativeCwd('/wt', '/wt', 'linux')).toBe(true);
    expect(sameNativeCwd('/WT', '/wt', 'linux')).toBe(false);
    expect(sameNativeCwd('/wt/', '/wt', 'linux')).toBe(false);
  });

  it('ignores case, separators and the verbatim prefix on Windows', () => {
    const wt = 'C:\\Users\\A\\repo';
    for (const recorded of [
      'c:\\users\\a\\repo',
      'C:/Users/A/repo',
      'C:\\Users\\A\\repo\\',
      '\\\\?\\C:\\Users\\A\\repo',
    ]) {
      expect(sameNativeCwd(recorded, wt, 'win32')).toBe(true);
    }
    expect(sameNativeCwd('\\\\?\\UNC\\host\\share\\repo', '\\\\host\\share\\repo', 'win32')).toBe(
      true,
    );
    expect(sameNativeCwd('C:\\Users\\A\\repo-copy', wt, 'win32')).toBe(false);
    expect(sameNativeCwd('D:\\Users\\A\\repo', wt, 'win32')).toBe(false);
  });
});

describe('Windows process recognition', () => {
  const claude = (command: string) =>
    matchesAgentProcess(command, 'claude', ['@anthropic-ai/claude-code/cli.js'], 'win32');
  const codex = (command: string) =>
    matchesAgentProcess(command, 'codex', ['@openai/codex/bin/codex.js'], 'win32');

  it.each([
    '"C:\\Users\\a\\.local\\bin\\claude.exe" --resume ref',
    'C:\\Users\\a\\.local\\bin\\CLAUDE.EXE',
    'claude.exe',
    'claude',
    '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    'node.exe "C:\\Users\\O\'Neil\\npm\\node_modules\\@Anthropic-AI\\claude-code\\cli.js" --resume x',
    'bun.exe C:\\tools\\claude',
  ])('recognises Claude Code from %s', (command) => {
    expect(claude(command)).toBe(true);
  });

  it.each([
    'node.exe C:\\work\\server.js --prompt claude',
    'node.exe -e claude',
    'cmd.exe /c claude',
    '"C:\\Program Files\\Git\\usr\\bin\\vim.exe" claude.md',
    '',
  ])('does not infer Claude Code from arguments: %s', (command) => {
    expect(claude(command)).toBe(false);
  });

  it('recognises the native Codex binary an npm launcher starts', () => {
    expect(codex('"C:\\npm\\node_modules\\@openai\\codex\\vendor\\x\\codex\\codex.exe" app')).toBe(
      true,
    );
    expect(codex('node C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js')).toBe(true);
  });

  it('splits command lines as CommandLineToArgvW does', () => {
    expect(windowsArgv('"C:\\a b\\x.exe" one "two three" fo"u r"\\\\"" \'q\'')).toEqual([
      'C:\\a b\\x.exe',
      'one',
      'two three',
      'fou r\\',
      "'q'",
    ]);
    expect(windowsArgv('x.exe a\\"b c\\\\d')).toEqual(['x.exe', 'a"b', 'c\\\\d']);
  });
});

describe('Windows hook quoting', () => {
  it('quotes literals for PowerShell and Git Bash', () => {
    expect(powershellLiteral("C:\\O'Neil $x\\‘q’")).toBe("'C:\\O''Neil $x\\‘‘q’’'");
    expect(gitBashPathLiteral("C:\\O'Neil $x")).toBe("'C:/O'\\''Neil $x'");
  });

  it('keeps the POSIX Gemini command and uses the call operator on Windows', () => {
    const script = 'C:\\cfg\\.gemini\\puddle-signal.mjs';
    expect(geminiHookCommand(script, ['session_start'], 'linux')).toBe(
      `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} session_start`,
    );
    expect(geminiHookCommand(script, ['session_start'], 'win32')).toBe(
      `& ${powershellLiteral(process.execPath)} '${script}' session_start`,
    );
  });

  it('installs PowerShell-form Gemini hooks on Windows and replaces them idempotently', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'gm-win-'));
    installGeminiLifecycleHooks(cfg, 'linux');
    installGeminiLifecycleHooks(cfg, 'win32');
    installGeminiLifecycleHooks(cfg, 'win32');
    const settings = JSON.parse(readFileSync(join(cfg, '.gemini', 'settings.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    for (const event of ['SessionStart', 'SessionEnd', 'BeforeAgent', 'AfterAgent']) {
      expect(settings.hooks[event]).toHaveLength(1);
      expect(settings.hooks[event]![0]!.hooks[0]!.command).toMatch(/^& '/);
    }
  });
});

describe('Windows environment handling', () => {
  it('scrubs credentials and nested-session markers under any spelling', () => {
    const base = {
      Anthropic_Api_Key: 'k',
      anthropic_auth_token: 't',
      ClaudeCode: '1',
      claude_code_entrypoint: 'cli',
      Claude_Config_Dir: '/old',
      Path: 'p',
    };
    expect(scrubbedEnv('/cfg', 'win32', base)).toEqual({ Claude_Config_Dir: '/cfg', Path: 'p' });
    // POSIX names are case-sensitive: only the exact spellings are scrubbed.
    expect(scrubbedEnv('/cfg', 'linux', { ...base, ANTHROPIC_API_KEY: 'k' })).toEqual({
      ...base,
      CLAUDE_CONFIG_DIR: '/cfg',
    });
  });
});

describe('Codex thread index on Windows', () => {
  it('matches the state rows of one directory spelt differently', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-win-'));
    const db = new Database(join(cfg, 'state_5.sqlite'));
    db.exec(`create table threads (id text primary key, cwd text not null,
      created_at integer not null, rollout_path text not null, source text not null)`);
    db.prepare(`insert into threads values ('a', '\\\\?\\C:\\Users\\A\\wt', 1, '/r', 'cli')`).run();
    db.prepare(`insert into threads values ('b', 'C:\\Users\\A\\other', 2, '/r', 'cli')`).run();
    db.close();
    expect(codexThreadIndex(cfg, 'c:/users/a/wt', 'win32').threads.map((t) => t.id)).toEqual(['a']);
    expect(codexThreadIndex(cfg, 'c:/users/a/wt', 'linux').threads).toEqual([]);
  });
});

describe('lifecycle version probes', () => {
  it('retries a failed Windows probe after a minute but caches POSIX failures', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const windows = lifecycleVersionAtLeast('puddle-absent-cli', ['--version'], [1, 0, 0], 'win32');
    expect(await windows).toBe(false);
    expect(lifecycleVersionAtLeast('puddle-absent-cli', ['--version'], [1, 0, 0], 'win32')).toBe(
      windows,
    );
    const posix = lifecycleVersionAtLeast('puddle-absent-cli', ['-v'], [1, 0, 0], 'linux');
    expect(await posix).toBe(false);
    vi.setSystemTime(Date.now() + 61_000);
    expect(
      lifecycleVersionAtLeast('puddle-absent-cli', ['--version'], [1, 0, 0], 'win32'),
    ).not.toBe(windows);
    expect(lifecycleVersionAtLeast('puddle-absent-cli', ['-v'], [1, 0, 0], 'linux')).toBe(posix);
  });
});

describe.runIf(process.platform === 'win32')('Codex app-server stop on Windows', () => {
  it('stops the npm launcher and the native server it started', async () => {
    const launcher = spawn(
      process.execPath,
      [
        '-e',
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let output = '';
    launcher.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    await waitFor(() => /\d+\s/.test(output));
    const server = Number(output.trim());
    stopProcess(launcher, 'win32');
    await waitFor(() => !isPidAlive(server, 'win32') && !isPidAlive(launcher.pid!, 'win32'));
  });
});
