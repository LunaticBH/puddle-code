import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPidAlive, system32Path } from '@puddle/shared/node/platform';
import { LogStore } from '../../src/logs/log-store.js';
import { stripAnsi } from '../../src/pty/ansi.js';
import { PtyManager, type PtyExitEvent } from '../../src/pty/pty-manager.js';
import { planPtySpawn, quoteWindowsArgument, windowsCommandLine } from '../../src/pty/pty-spawn.js';
import {
  isConsoleHostTitle,
  STATUS_CONTROL_C_EXIT,
  windowsExitCodeLabel,
} from '../../src/pty/windows-console.js';
import { writeFakeExecutable } from '../helpers/fake-executable.js';

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Windows command lines', () => {
  it('quotes arguments as the C runtime parses them', () => {
    expect(quoteWindowsArgument('plain')).toBe('plain');
    expect(quoteWindowsArgument('')).toBe('""');
    expect(quoteWindowsArgument('a b')).toBe('"a b"');
    expect(quoteWindowsArgument('"quoted"')).toBe('"\\"quoted\\""');
    expect(quoteWindowsArgument('x"y')).toBe('"x\\"y"');
    expect(quoteWindowsArgument('C:\\dir\\')).toBe('C:\\dir\\');
    expect(quoteWindowsArgument('C:\\my dir\\')).toBe('"C:\\my dir\\\\"');
    expect(quoteWindowsArgument('a\\"b c')).toBe('"a\\\\\\"b c"');
    expect(quoteWindowsArgument('tab\there')).toBe('"tab\there"');
  });

  it('joins a quoted argv, or a verbatim cmd.exe line as given', () => {
    expect(windowsCommandLine(['-e', 'a b', ''])).toBe('-e "a b" ""');
    expect(windowsCommandLine(['/d', '/s', '/c', '"x.cmd "a b""'], true)).toBe(
      '/d /s /c "x.cmd "a b""',
    );
    expect(windowsCommandLine([])).toBe('');
  });
});

describe('planPtySpawn', () => {
  it('is the plain environment spread and argv on POSIX', () => {
    const plan = planPtySpawn(
      'bash',
      ['-c', 'echo "a b"'],
      { PATH: '/override' },
      {
        platform: 'linux',
        base: { PATH: '/usr/bin', HOME: '/home/a' },
      },
    );
    expect(plan).toEqual({
      file: 'bash',
      args: ['-c', 'echo "a b"'],
      env: { PATH: '/override', HOME: '/home/a' },
    });
  });

  it('on win32 resolves PATHEXT, quotes the argv and keeps one spelling per variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-plan-'));
    const tool = join(dir, 'tool.exe');
    writeFileSync(tool, '');
    const plan = planPtySpawn(
      'tool',
      ['a b', '"q"'],
      { PATH: dir, FOO: 'override', Term: 'dumb' },
      { platform: 'win32', base: { Path: 'C:\\Windows', foo: 'base', ComSpec: 'C:\\cmd.exe' } },
    );
    expect(plan.file).toBe(tool);
    expect(plan.args).toBe('"a b" "\\"q\\""');
    expect(plan.env).toEqual({
      Path: dir,
      foo: 'override',
      ComSpec: 'C:\\cmd.exe',
      // The override's spelling stays; node-pty itself sets TERM only on Unix.
      Term: 'xterm-256color',
    });
  });

  it('gives terminals the user’s working-directory program search, not the daemon’s', () => {
    const plan = (base: Record<string, string>, platform: NodeJS.Platform = 'win32') =>
      planPtySpawn('C:\\Windows\\System32\\cmd.exe', [], undefined, { platform, base }).env;
    // disableCurrentDirectorySearch's value: `gradlew` in a cmd.exe terminal must still run.
    expect(plan({ Path: 'C:\\Windows', NODEFAULTCURRENTDIRECTORYINEXEPATH: 'puddle' })).toEqual({
      Path: 'C:\\Windows',
      TERM: 'xterm-256color',
    });
    // A value the user set themselves stays.
    expect(plan({ NoDefaultCurrentDirectoryInExePath: '1' })).toMatchObject({
      NoDefaultCurrentDirectoryInExePath: '1',
    });
    expect(plan({ NoDefaultCurrentDirectoryInExePath: 'puddle' }, 'linux')).toEqual({
      NoDefaultCurrentDirectoryInExePath: 'puddle',
    });
  });
});

describe('ConPTY facts', () => {
  it('recognises the executable-path title inbox ConPTY sets', () => {
    expect(isConsoleHostTitle('C:\\WINDOWS\\SYSTEM32\\cmd.exe')).toBe(true);
    expect(isConsoleHostTitle('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(true);
    expect(isConsoleHostTitle('\\\\server\\tools\\agent.exe')).toBe(true);
    expect(isConsoleHostTitle('claude: fix the build')).toBe(false);
    expect(isConsoleHostTitle('notes about node.exe')).toBe(false);
  });

  it('prints NTSTATUS exit codes in hexadecimal', () => {
    expect(windowsExitCodeLabel(STATUS_CONTROL_C_EXIT)).toBe('0xC000013A');
    expect(windowsExitCodeLabel(1)).toBe('1');
  });
});

describe.skipIf(process.platform !== 'win32')('PtyManager on ConPTY', () => {
  function manager() {
    const logs = new LogStore(mkdtempSync(join(tmpdir(), 'puddle-logs-')), 64 * 1024);
    const ptys = new PtyManager(logs);
    const chunks: string[] = [];
    const exits: PtyExitEvent[] = [];
    ptys.on('data', (e: { data: string }) => chunks.push(e.data));
    ptys.on('exit', (e: PtyExitEvent) => exits.push(e));
    // ConPTY repaints and wraps: compare the text without escapes or line breaks.
    const output = () => stripAnsi(chunks.join('')).replace(/\r?\n/g, '');
    return { ptys, chunks, exits, output };
  }

  const tricky = ['a b', '"quoted"', 'trail\\', '', 'x"y', 'C:\\my dir\\', '100% & | ^ !x!'];

  it('passes arguments with spaces, quotes and backslashes through intact', async () => {
    const { ptys, output } = manager();
    ptys.spawn(
      's1',
      'agent',
      process.execPath,
      [
        '-e',
        "process.stdout.write('ARGV' + JSON.stringify(process.argv.slice(1)) + '\\n')",
        ...tricky,
      ],
      { cwd: tmpdir() },
    );
    await waitFor(() => output().includes('ARGV'));
    await waitFor(() => output().includes(']'));
    const argv = JSON.parse(/ARGV(\[.*\])/.exec(output().replace(/\r?\n/g, ''))![1]!);
    expect(argv).toEqual(tricky);
  });

  it('runs an npm-style .cmd shim by bare name, never through cmd.exe', async () => {
    const { ptys, output } = manager();
    const bin = mkdtempSync(join(tmpdir(), 'puddle-shim-'));
    writeFakeExecutable(
      bin,
      'fake-agent',
      "process.stdout.write('SHIM' + JSON.stringify(process.argv.slice(2)) + '\\n');",
    );
    ptys.spawn('s2', 'agent', 'fake-agent', tricky, {
      cwd: tmpdir(),
      env: { PATH: `${bin};${dirname(process.execPath)}` },
    });
    await waitFor(() => /SHIM\[.*\]/.test(output().replace(/\r?\n/g, '')));
    const argv = JSON.parse(/SHIM(\[.*\])/.exec(output().replace(/\r?\n/g, ''))![1]!);
    expect(argv).toEqual(tricky);
  });

  it('runs a batch file beside the shell by bare name, as any cmd.exe does', async () => {
    const { ptys, output } = manager();
    const cwd = mkdtempSync(join(tmpdir(), 'puddle-sibling-'));
    writeFileSync(join(cwd, 'puddle-sibling.bat'), '@echo SIBLING-%~1\r\n');
    // The daemon's own setting, as disableCurrentDirectorySearch makes it.
    const saved = Object.entries(process.env).filter(
      ([name]) => name.toLowerCase() === 'nodefaultcurrentdirectoryinexepath',
    );
    for (const [name] of saved) delete process.env[name];
    process.env.NoDefaultCurrentDirectoryInExePath = 'puddle';
    try {
      ptys.spawn('s6', 'agent', system32Path('cmd.exe'), ['/d', '/c', 'puddle-sibling ran'], {
        cwd,
      });
    } finally {
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      for (const [name, value] of saved) process.env[name] = value;
    }
    await waitFor(() => output().includes('SIBLING-ran') || output().includes('not recognized'));
    expect(output()).toContain('SIBLING-ran');
  });

  it('applies a PATH override without a second Path spelling', async () => {
    const { ptys, output } = manager();
    ptys.spawn(
      's3',
      'agent',
      process.execPath,
      [
        '-e',
        "const keys = Object.keys(process.env).filter((k) => k.toUpperCase() === 'PATH');" +
          "process.stdout.write('KEYS=' + keys.length + ' VALUE=' + process.env.PATH + '|\\n')",
      ],
      { cwd: tmpdir(), env: { PATH: 'C:\\override' } },
    );
    await waitFor(() => output().includes('|'));
    expect(output()).toContain('KEYS=1 VALUE=C:\\override|');
  });

  it('SIGKILL stops the whole process tree, even processes outside the console', async () => {
    const { ptys, output, exits } = manager();
    const script =
      "const { spawn } = require('node:child_process');" +
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });" +
      "process.stdout.write('CHILD=' + child.pid + '|\\n'); setInterval(() => {}, 1000);";
    ptys.spawn('s4', 'agent', process.execPath, ['-e', script], { cwd: tmpdir() });
    await waitFor(() => /CHILD=\d+\|/.test(output()));
    const child = Number(/CHILD=(\d+)\|/.exec(output())![1]);
    expect(isPidAlive(child)).toBe(true);
    ptys.kill('s4', 'agent', 'SIGKILL');
    await waitFor(() => exits.length === 1);
    await waitFor(() => !isPidAlive(child));
    expect(ptys.has('s4', 'agent')).toBe(false);
  });

  it('survives resize and kill before the first output, and reports a numeric exit', async () => {
    const { ptys, exits } = manager();
    ptys.spawn('s5', 'agent', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: tmpdir(),
    });
    ptys.resize('s5', 'agent', 90, 20);
    ptys.redraw('s5', 'agent');
    ptys.kill('s5', 'agent');
    ptys.kill('s5', 'agent'); // a second close must not reach the closed handle
    await waitFor(() => exits.length === 1);
    expect(typeof exits[0]!.exitCode).toBe('number');
  });

  it('never re-applies an unchanged size, which would repaint the whole screen', async () => {
    const { ptys, chunks, output, exits } = manager();
    ptys.spawn(
      's6',
      'agent',
      process.execPath,
      ['-e', "process.stdout.write('PAINTED\\n'); setInterval(() => {}, 1000)"],
      { cwd: tmpdir() },
    );
    await waitFor(() => output().includes('PAINTED'));
    await new Promise((r) => setTimeout(r, 500)); // ConPTY's own start-up painting
    const settled = chunks.length;
    // A viewer re-attaching at the size the PTY already has (it started at 120x32).
    ptys.resize('s6', 'agent', 120, 32);
    ptys.resize('s6', 'agent', 120, 32);
    await new Promise((r) => setTimeout(r, 500));
    expect(chunks.slice(settled)).toEqual([]);
    // A real size change still reaches the pseudoconsole, which repaints.
    ptys.resize('s6', 'agent', 100, 30);
    await waitFor(() => chunks.length > settled);
    ptys.kill('s6', 'agent', 'SIGKILL');
    await waitFor(() => exits.length === 1);
  });
});
