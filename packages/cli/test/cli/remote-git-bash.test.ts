import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorRun } from '../../src/lib/installation/windows-connector.js';

/**
 * `puddle remote … user@host` against a Windows host whose OpenSSH default
 * shell is Git Bash (docs/windows.md, decision 19): `true` and the two fixed
 * POSIX commands succeed there, so only the connector's own `--version`
 * tells. From then on the host helper drives it over PowerShell.
 */

interface Spawned {
  args: string[];
}
const spawned = vi.hoisted(() => [] as Spawned[]);
const answers = vi.hoisted(() => ({
  version: '',
  elevatedSupervisor: false,
  /** The connection drops once the enable has succeeded. */
  dropAfterEnable: false,
  enabled: false,
}));

const probe = JSON.stringify({
  puddle: 'windows-host',
  home: 'C:\\Users\\a\\.puddle',
  current: 'C:\\Users\\a\\.puddle\\bin\\versions\\1.2.3',
  node: 'x64',
  arch: 'x64',
  build: 26200,
  elevated: false,
  temp: 'C:\\Users\\a\\AppData\\Local\\Temp\\',
});

// Every ssh child: a Git Bash default shell answering POSIX commands, and the
// PowerShell loader answering the probe.
vi.mock('../../src/lib/transport/spawn.js', () => ({
  spawnClient: (_file: string, args: string[], options: SpawnOptions) => {
    spawned.push({ args });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    const command = args.at(-1) ?? '';
    const reply =
      answers.dropAfterEnable && answers.enabled
        ? { code: 255, stdout: '', stderr: 'Connection closed by remote host\n' }
        : command.startsWith('powershell.exe ')
          ? {
              code: 1,
              stdout: `${JSON.stringify({ ...JSON.parse(probe), elevatedSupervisor: answers.elevatedSupervisor })}\r\n`,
              stderr: 'puddle-exit:0\n',
            }
          : command.includes('--version')
            ? { code: 0, stdout: answers.version, stderr: '' }
            : { code: 0, stdout: '', stderr: '' };
    const finish = () => {
      child.stdout.end(reply.stdout);
      child.stderr.end(reply.stderr);
      setImmediate(() => child.emit('close', reply.code));
    };
    if (Array.isArray(options.stdio) && options.stdio[0] === 'pipe') {
      child.stdin.on('finish', finish);
      child.stdin.resume();
    } else setImmediate(finish);
    return child;
  },
}));

const host = vi.hoisted(() => ({
  connectorInstalled: vi.fn(async () => ({ installed: true, version: '1.2.3' as string | null })),
  connector: vi.fn(
    async (args: readonly string[], _opts?: { stdin?: string; timeoutMs?: number }) => {
      if (args[0] === '--configure') answers.enabled = true;
      return {
        code: 0,
        stdout:
          args[0] === '--version'
            ? 'puddle-connector remote protocol 4; cockpit controls 2; platform win32\n'
            : JSON.stringify({ enabled: true, connected: false }),
        stderr: '',
      } as ConnectorRun;
    },
  ),
  connectorForeground: vi.fn(async (_write: (text: string) => void) => 0),
}));
// The Windows SSH host's helper operations (windows-remote-host.ts), scripted.
vi.mock('../../src/lib/host/windows-remote-host.js', async (actual) => ({
  elevatedWarning: (await actual<typeof import('../../src/lib/host/windows-remote-host.js')>())
    .elevatedWarning,
  remoteWindowsHost: () => host,
}));

import { runRemote } from '../../src/cli/remote.js';
import { windowsRemoteCommand } from '../../src/lib/transport/windows-remote.js';

const posixVersion =
  'puddle-connector remote protocol 4; daemon protocol 25.7; cockpit controls 2; delete registration 1\n';
const commands = () => spawned.map((s) => s.args.at(-1));

let savedHome: string | undefined;
let clientHome: string;
beforeAll(() => {
  savedHome = process.env.PUDDLE_HOME;
  clientHome = mkdtempSync(join(tmpdir(), 'puddle-remote-gitbash-'));
  process.env.PUDDLE_HOME = clientHome;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.PUDDLE_HOME;
  else process.env.PUDDLE_HOME = savedHome;
  rmSync(clientHome, { recursive: true, force: true });
});
beforeEach(() => {
  spawned.length = 0;
  answers.elevatedSupervisor = false;
  answers.dropAfterEnable = false;
  answers.enabled = false;
  host.connector.mockClear();
  host.connectorForeground.mockClear();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

describe('puddle remote on a Windows host whose default shell is Git Bash', () => {
  it('drives remote enable through the host helper once the connector names Windows', async () => {
    answers.version = posixVersion.replace('\n', '; platform win32\n');
    await expect(
      runRemote({
        cmd: 'remote',
        action: 'enable',
        host: 'alice@gitbash',
        profile: 'b'.repeat(10),
        foreground: false,
      }),
    ).resolves.toBe(0);
    const sent = commands();
    // `true`, the two fixed POSIX commands, then only PowerShell.
    expect(sent[0]).toBe('true');
    expect(sent.slice(1, 3)).toEqual([
      expect.stringContaining('test -f'),
      expect.stringContaining('connector.mjs --version'),
    ]);
    expect(sent.slice(3).every((command) => command === windowsRemoteCommand())).toBe(true);
    expect(sent.slice(3)).not.toHaveLength(0);
    const configure = host.connector.mock.calls.find(([args]) => args[0] === '--configure');
    expect(configure).toBeDefined();
    // The helper's guard and the Windows enable's time to start the supervisor.
    expect(configure![1]!.timeoutMs).toBe(120_000);
    expect(JSON.parse(configure![1]!.stdin!)).toMatchObject({ setup: { managed: true } });
  });

  it('warns after enabling when the supervisor runs with an elevated session’s token', async () => {
    answers.version = posixVersion.replace('\n', '; platform win32\n');
    answers.elevatedSupervisor = true;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runRemote({
        cmd: 'remote',
        action: 'enable',
        host: 'alice@gitbash',
        profile: 'b'.repeat(10),
        foreground: false,
      });
      expect(stderr.mock.calls.map(([text]) => String(text)).join('')).toContain(
        'puddled on alice@gitbash runs elevated',
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('still succeeds when the host stops answering the elevation check after enabling', async () => {
    answers.version = posixVersion.replace('\n', '; platform win32\n');
    answers.elevatedSupervisor = true;
    answers.dropAfterEnable = true;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        runRemote({
          cmd: 'remote',
          action: 'enable',
          host: 'alice@gitbash',
          profile: 'b'.repeat(10),
          foreground: false,
        }),
      ).resolves.toBe(0);
      expect(stdout.mock.calls.map(([text]) => String(text)).join('')).toContain(
        'Remote access enabled',
      );
      // The check was asked and got no answer: no warning, and no failure.
      expect(commands().at(-1)).toBe(windowsRemoteCommand());
      expect(stderr.mock.calls.map(([text]) => String(text)).join('')).not.toContain(
        'runs elevated',
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('runs the connector’s foreground manager through the host helper', async () => {
    answers.version = posixVersion.replace('\n', '; platform win32\n');
    await expect(
      runRemote({ cmd: 'remote', action: 'run', host: 'alice@gitbash', foreground: false }),
    ).resolves.toBe(0);
    expect(host.connectorForeground).toHaveBeenCalledOnce();
    expect(commands().filter((command) => command !== windowsRemoteCommand())).toHaveLength(3);
  });

  it('leaves a POSIX connector, which names no platform, on its POSIX commands', async () => {
    answers.version = posixVersion;
    await runRemote({
      cmd: 'remote',
      action: 'status',
      host: 'alice@devbox',
      profile: 'b'.repeat(10),
      foreground: false,
    }).catch(() => undefined);
    expect(commands()).not.toContain(windowsRemoteCommand());
    expect(host.connector).not.toHaveBeenCalled();
  });
});
