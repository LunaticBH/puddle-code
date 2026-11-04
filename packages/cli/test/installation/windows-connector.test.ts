import { copyFileSync, linkSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRemoteArgs, runRemote } from '../../src/cli/remote.js';
import {
  connectorEnvironment,
  runWindowsConnector,
  windowsConnectorInstalled,
  windowsConnectorPaths,
  type WindowsConnectorRunner,
} from '../../src/lib/installation/windows-connector.js';

/** A home whose `bin\current` holds a node.exe and the given connector script. */
function homeWithConnector(script: string) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-windows-connector-'));
  const { node, script: entry } = windowsConnectorPaths(home);
  mkdirSync(join(node, '..'), { recursive: true });
  mkdirSync(join(entry, '..'), { recursive: true });
  try {
    linkSync(process.execPath, node);
  } catch {
    copyFileSync(process.execPath, node);
  }
  writeFileSync(entry, script);
  return home;
}

afterEach(() => vi.restoreAllMocks());

describe('the connector on this Windows machine', () => {
  it('runs through the current junction with the home always named', () => {
    const paths = windowsConnectorPaths(join('C:', 'h'));
    expect(paths.node).toBe(join('C:', 'h', 'bin', 'current', 'bin', 'node.exe'));
    expect(paths.script).toBe(join('C:', 'h', 'bin', 'current', 'daemon', 'connector.mjs'));
    const env = connectorEnvironment('relative-home', {
      Path: 'C:\\Windows',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
    });
    expect(env).toEqual({
      Path: 'C:\\Windows',
      PUDDLE_HOME: resolve('relative-home'),
      NoDefaultCurrentDirectoryInExePath: 'puddle',
    });
  });

  it('passes values on stdin only and reports the connector’s own status', async () => {
    const home = homeWithConnector(
      [
        "let input = '';",
        "process.stdin.on('data', (chunk) => (input += chunk));",
        "process.stdin.on('end', () => {",
        '  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input, home: process.env.PUDDLE_HOME }));',
        '  process.exitCode = 3;',
        '});',
      ].join('\n'),
    );
    expect(windowsConnectorInstalled(home)).toBe(true);
    const result = await runWindowsConnector(home, ['--admin'], {
      stdin: '{"profile":"x"}\n',
      timeoutMs: 30_000,
    });
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({
      args: ['--admin'],
      input: '{"profile":"x"}\n',
      home: resolve(home),
    });
  }, 60_000);

  it('gives up on a connector that does not answer in time', async () => {
    const home = homeWithConnector('setInterval(() => {}, 1000);\n');
    const result = await runWindowsConnector(home, ['--inspect'], { timeoutMs: 1000 });
    expect(result.code).toBe(124);
  }, 60_000);
});

describe.runIf(process.platform === 'win32')('puddle remote on this Windows machine', () => {
  it('runs the installed connector locally, with JSON on stdin', async () => {
    const home = homeWithConnector('');
    const run = vi.fn<WindowsConnectorRunner>(async (_home, args) => ({
      code: 0,
      stdout:
        args[0] === '--version'
          ? 'puddle-connector remote protocol 4; cockpit controls 2'
          : JSON.stringify({ enabled: false, connected: false }),
      stderr: '',
    }));
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const profile = 'e'.repeat(10);
    expect(await runRemote(parseRemoteArgs(['disable', '--profile', profile]), { run, home })).toBe(
      0,
    );
    expect(run.mock.calls.map(([, args]) => args)).toEqual([['--version'], ['--admin']]);
    expect(JSON.parse(run.mock.calls[1]![2]!.stdin!)).toEqual({
      profile,
      request: { t: 'disable' },
    });
    expect(output.join('')).toBe('Remote access disabled, disconnected\n');
  });

  it('says when the installed release has no connector', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-windows-connector-'));
    const run = vi.fn<WindowsConnectorRunner>();
    await expect(
      runRemote(parseRemoteArgs(['status', '--profile', 'e'.repeat(10)]), { run, home }),
    ).rejects.toMatchObject({ code: 'not_installed' });
    expect(run).not.toHaveBeenCalled();
  });
});
