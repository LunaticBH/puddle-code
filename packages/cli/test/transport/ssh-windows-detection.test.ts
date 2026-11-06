import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface Spawned {
  args: string[];
  stdin: string;
  stdio: SpawnOptions['stdio'];
}
interface Reply {
  code: number;
  stdout?: string;
  stderr?: string;
  /** ssh exits, but a process it left behind keeps its standard streams open. */
  lingers?: true;
}
const spawned = vi.hoisted(() => [] as Spawned[]);
const host = vi.hoisted(() => ({ reply: (_spawned: Spawned): Reply => ({ code: 0 }) }));

// Every ssh child goes through spawnClient: record it and answer as `host.reply` says.
vi.mock('../../src/lib/transport/spawn.js', () => ({
  spawnClient: (_file: string, args: string[], options: SpawnOptions) => {
    const entry: Spawned = { args, stdin: '', stdio: options.stdio };
    spawned.push(entry);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    const finish = () => {
      const reply = host.reply(entry);
      if (reply.lingers) {
        child.stderr.write(reply.stderr ?? '');
        setImmediate(() => child.emit('exit', reply.code, null));
        return;
      }
      child.stdout.end(reply.stdout ?? '');
      child.stderr.end(reply.stderr ?? '');
      setImmediate(() => {
        child.emit('exit', reply.code, null);
        child.emit('close', reply.code);
      });
    };
    if (Array.isArray(options.stdio) && options.stdio[0] === 'pipe') {
      child.stdin.on('data', (chunk: Buffer) => (entry.stdin += chunk.toString()));
      child.stdin.on('finish', finish);
    } else setImmediate(finish);
    return child;
  },
}));

import { launcherRemotePlatform } from '../../src/cli/detach.js';
import { inspectHost } from '../../src/lib/auth/control-channel.js';
import { installDaemon } from '../../src/lib/installation/bootstrap.js';
import { hostPaths } from '../../src/lib/paths.js';
import { SshTransport } from '../../src/lib/transport/ssh.js';
import { windowsRemoteCommand } from '../../src/lib/transport/windows-remote.js';
import {
  CMD_TRUE_ANSWER,
  HOST_KEY_WARNING,
  POWERSHELL_TRUE_ANSWER,
} from '../helpers/windows-true-answers.js';

const probe = JSON.stringify({
  puddle: 'windows-host',
  home: 'C:\\Users\\a\\.puddle',
  current: null,
  node: null,
  arch: 'x64',
  build: 26200,
  elevated: false,
  temp: 'C:\\Users\\a\\AppData\\Local\\Temp\\',
});
const isProbe = (s: Spawned) => s.args.at(-1) === windowsRemoteCommand();
const windowsProbeAnswer: Reply = { code: 1, stdout: `${probe}\r\n`, stderr: 'puddle-exit:0\n' };
/** A Windows host whose default shell answers POSIX `true` with `trueStatus`. */
const windowsHost =
  (trueStatus: number) =>
  (s: Spawned): Reply =>
    isProbe(s)
      ? windowsProbeAnswer
      : { code: trueStatus, stderr: "'true' is not recognized as an internal or external command" };

const savedHome = process.env.PUDDLE_HOME;
beforeAll(() => {
  process.env.PUDDLE_HOME = join(mkdtempSync(join(tmpdir(), 'puddle-ssh-detect-')), '.puddle');
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.PUDDLE_HOME;
  else process.env.PUDDLE_HOME = savedHome;
});
beforeEach(() => {
  spawned.length = 0;
});

describe('recognising a Windows SSH host', () => {
  for (const platform of ['linux', 'win32'] as const) {
    it(`sends a POSIX host only \`true\` (${platform} client)`, async () => {
      host.reply = () => ({ code: 0 });
      const ssh = new SshTransport('alice@devbox', { platform });
      await ssh.open();
      expect(spawned.map((s) => s.args.at(-1))).toEqual(['true']);
      expect(ssh.remotePlatform).toBeUndefined();
    });
  }

  it('treats ssh’s own failure as unreachable, without a probe', async () => {
    host.reply = () => ({ code: 255 });
    const ssh = new SshTransport('alice@devbox', { platform: 'linux' });
    await expect(ssh.open()).rejects.toMatchObject({
      code: 'ssh_unreachable',
      message: 'could not open an SSH connection to alice@devbox',
    });
    expect(spawned).toHaveLength(1);
  });

  for (const status of [1, 49, 9009]) {
    it(`probes once after \`true\` fails with ${status}, and remembers Windows`, async () => {
      host.reply = windowsHost(status);
      const ssh = new SshTransport('alice@winbox', { platform: 'linux' });
      await ssh.open();
      expect(ssh.remotePlatform).toBe('win32');
      expect(spawned).toHaveLength(2);
      const [, second] = spawned;
      expect(second!.args.slice(-3)).toEqual(['alice@winbox', '--', windowsRemoteCommand()]);
      expect(second!.stdin).toMatch(/^PUDDLE1 \d+\n/);
      expect((await ssh.windowsProbe()).arch).toBe('x64');
      // Sticky: the next open sends the probe alone.
      spawned.length = 0;
      await ssh.open();
      expect(spawned.map(isProbe)).toEqual([true]);
    });
  }

  it('fails as before when the probe gets no Windows answer', async () => {
    host.reply = (s) =>
      isProbe(s)
        ? { code: 127, stderr: 'sh: 1: powershell.exe: not found\n' }
        : { code: 1, stderr: 'This account is restricted to git\n' };
    const ssh = new SshTransport('alice@gitbox', { platform: 'linux' });
    await expect(ssh.open()).rejects.toMatchObject({
      code: 'ssh_unreachable',
      message: 'could not open an SSH connection to alice@gitbox',
      hint: "check that 'ssh alice@gitbox' works on its own",
    });
    expect(ssh.remotePlatform).toBeUndefined();
    expect(spawned).toHaveLength(2);
  });

  it('refuses a ConstrainedLanguage session clearly', async () => {
    host.reply = (s) =>
      isProbe(s)
        ? {
            code: 1,
            stderr:
              '#< CLIXML\r\n<Objs><S S="Error">Cannot invoke method. Method invocation is supported only on core types in this language mode.</S></Objs>',
          }
        : { code: 1 };
    const ssh = new SshTransport('alice@locked', { platform: 'linux' });
    await expect(ssh.open()).rejects.toMatchObject({
      code: 'unsupported_platform',
      message: expect.stringContaining('ConstrainedLanguage'),
    });
  });

  it('opens a host a launcher already recognised with the probe alone', async () => {
    host.reply = windowsHost(1);
    const ssh = new SshTransport('alice@winbox', { platform: 'win32', remotePlatform: 'win32' });
    await ssh.open();
    expect(spawned.map(isProbe)).toEqual([true]);
  });

  it('keeps a Linux or macOS client’s terminal inherited for `true`', async () => {
    host.reply = windowsHost(1);
    for (const platform of ['linux', 'darwin'] as const) {
      spawned.length = 0;
      await new SshTransport('alice@winbox', { platform }).open();
      expect(spawned[0]!.stdio).toBe('inherit');
    }
  });

  it('hands the platform only to the background cockpit its launcher started', () => {
    const child = { PUDDLE_COCKPIT_CHILD: '1', PUDDLE_REMOTE_PLATFORM: 'win32' };
    expect(launcherRemotePlatform(child)).toBe('win32');
    expect(launcherRemotePlatform({ PUDDLE_REMOTE_PLATFORM: 'win32' })).toBeUndefined();
    expect(launcherRemotePlatform({ ...child, PUDDLE_REMOTE_PLATFORM: 'linux' })).toBeUndefined();
  });
});

describe('the `true` probe’s standard error on a Windows client', () => {
  /** Where the transport relays the probe's standard error, as it is written. */
  function terminal() {
    let text = '';
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        text += chunk.toString();
        done();
      },
    });
    return { sink, text: () => text };
  }
  const answering =
    (answer: string, probeAnswer: Reply = windowsProbeAnswer) =>
    (s: Spawned): Reply =>
      isProbe(s) ? probeAnswer : { code: 1, stderr: HOST_KEY_WARNING + answer };

  for (const [shell, answer] of [
    ['cmd.exe', CMD_TRUE_ANSWER],
    ['Windows PowerShell', POWERSHELL_TRUE_ANSWER],
  ] as const) {
    it(`shows ssh’s own lines but not ${shell}’s answer to \`true\``, async () => {
      host.reply = answering(answer);
      const { sink, text } = terminal();
      const ssh = new SshTransport('alice@winbox', { platform: 'win32', probeStderr: sink });
      await ssh.open();
      expect(ssh.remotePlatform).toBe('win32');
      expect(spawned[0]!.stdio).toEqual(['inherit', 'inherit', 'pipe']);
      expect(text()).toBe(HOST_KEY_WARNING);
    });
  }

  it('relays a POSIX host’s standard error unchanged', async () => {
    const banner = "Authorised users only.\n'true' story\r\n";
    host.reply = () => ({ code: 0, stderr: banner });
    const { sink, text } = terminal();
    await new SshTransport('alice@devbox', { platform: 'win32', probeStderr: sink }).open();
    expect(text()).toBe(banner);
  });

  it('shows the answer when the host does not prove to be Windows', async () => {
    host.reply = answering(CMD_TRUE_ANSWER, { code: 127, stderr: 'powershell.exe: not found\n' });
    const { sink, text } = terminal();
    const ssh = new SshTransport('alice@oddbox', { platform: 'win32', probeStderr: sink });
    await expect(ssh.open()).rejects.toMatchObject({ code: 'ssh_unreachable' });
    expect(text()).toBe(HOST_KEY_WARNING + CMD_TRUE_ANSWER);
  });

  it('decides soon after ssh exits though something still holds its standard error', async () => {
    host.reply = (s) =>
      isProbe(s) ? windowsProbeAnswer : { code: 1, stderr: CMD_TRUE_ANSWER, lingers: true };
    const { sink, text } = terminal();
    const ssh = new SshTransport('alice@winbox', { platform: 'win32', probeStderr: sink });
    const started = Date.now();
    await ssh.open();
    expect(Date.now() - started).toBeLessThan(4000);
    expect(ssh.remotePlatform).toBe('win32');
    expect(text()).toBe('');
  });

  it('leaves a graphical embedder’s probe, which has no terminal, as it was', async () => {
    host.reply = answering(CMD_TRUE_ANSWER);
    const ssh = new SshTransport('alice@winbox', {
      platform: 'win32',
      askpassProgram: 'C:\\Puddle\\ssh-askpass.exe',
    });
    await ssh.open();
    expect(spawned[0]!.stdio).toBe('ignore');
  });
});

describe('a host recognised by a failed POSIX command', () => {
  it('confirms a Windows signature with the probe and returns the result unchanged', async () => {
    // A Git Bash default shell: `true` passes, the helper stage gives it away.
    host.reply = (s) =>
      isProbe(s)
        ? { code: 0, stdout: probe, stderr: 'puddle-exit:0\n' }
        : s.args.at(-1) === 'true'
          ? { code: 0 }
          : { code: 1, stderr: 'TypeError: process.getuid is not a function\n' };
    const ssh = new SshTransport('alice@gitbash', { platform: 'linux' });
    await ssh.open();
    expect(ssh.remotePlatform).toBeUndefined();
    const result = await ssh.exec('node -e stage', { revealsWindows: true });
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'TypeError: process.getuid is not a function\n',
    });
    expect(ssh.remotePlatform).toBe('win32');
  });

  it('recognises a Git Bash host from the control-helper stage and from install.sh', async () => {
    const gitBash = (failure: Reply) => (s: Spawned) =>
      isProbe(s)
        ? { code: 0, stdout: probe, stderr: 'puddle-exit:0\n' }
        : s.args.at(-1) === 'true'
          ? { code: 0 }
          : failure;
    host.reply = gitBash({ code: 1, stderr: 'TypeError: process.getuid is not a function\n' });
    const staged = new SshTransport('alice@gitbash', { platform: 'linux' });
    await staged.open();
    await inspectHost(staged).catch(() => null);
    expect(staged.remotePlatform).toBe('win32');

    host.reply = gitBash({ code: 1, stdout: 'install.sh: unsupported OS MINGW64_NT-10.0-26200\n' });
    const installing = new SshTransport('alice@gitbash', { platform: 'linux' });
    await installing.open();
    const repo = process.env.PUDDLE_REPO;
    process.env.PUDDLE_REPO = 'acme/puddle';
    try {
      await installDaemon(installing, { version: '1.2.3' }).catch(() => null);
    } finally {
      if (repo === undefined) delete process.env.PUDDLE_REPO;
      else process.env.PUDDLE_REPO = repo;
    }
    expect(installing.remotePlatform).toBe('win32');
  });

  it('never probes after a command whose output relays user content', async () => {
    // `puddle logs --follow` on a POSIX host whose agent printed Windows errors,
    // then lost its connection: the log text is not the host answering.
    host.reply = (s) =>
      isProbe(s)
        ? { code: 0, stdout: probe, stderr: 'puddle-exit:0\n' }
        : {
            code: 1,
            stdout: "'x' is not recognized as an internal or external command\nMINGW64_NT-10.0\n",
          };
    const ssh = new SshTransport('alice@devbox', { platform: 'linux' });
    const relayed: string[] = [];
    await ssh.exec('tail -f -c 262144 agent.log', { onStdout: (text) => relayed.push(text) });
    expect(relayed.join('')).toContain('MINGW64_NT');
    expect(spawned).toHaveLength(1);
    expect(ssh.remotePlatform).toBeUndefined();
  });

  for (const code of [255, -1]) {
    it(`never probes after ssh’s own failure or a killed command (${code})`, async () => {
      host.reply = (s) =>
        isProbe(s)
          ? { code: 0, stdout: probe, stderr: 'puddle-exit:0\n' }
          : { code, stderr: 'TypeError: process.getuid is not a function\n' };
      const ssh = new SshTransport('alice@devbox', { platform: 'linux' });
      await ssh.exec('node -e stage', { revealsWindows: true });
      expect(spawned).toHaveLength(1);
      expect(ssh.remotePlatform).toBeUndefined();
    });
  }

  it('sends nothing more after an ordinary POSIX failure', async () => {
    host.reply = () => ({ code: 127, stderr: 'sh: 1: node: not found\n' });
    const ssh = new SshTransport('alice@devbox', { platform: 'linux' });
    await ssh.exec('node -v');
    expect(spawned).toHaveLength(1);
    expect(ssh.remotePlatform).toBeUndefined();
  });

  it('refuses every POSIX operation once the host is known to be Windows', async () => {
    host.reply = windowsHost(1);
    const ssh = new SshTransport('alice@winbox', { platform: 'linux', remotePlatform: 'win32' });
    spawned.length = 0;
    await expect(ssh.exec('rm -rf ~')).rejects.toMatchObject({ code: 'unsupported_platform' });
    expect(() => ssh.runAttached('puddled')).toThrow(/Windows host/);
    expect(() => ssh.openChannel('node helper')).toThrow(/Windows host/);
    await expect(ssh.copyTo('a.zip', '.puddle/cache/a.zip')).rejects.toMatchObject({
      code: 'unsupported_platform',
    });
    await expect(ssh.readFile('/etc/passwd')).rejects.toMatchObject({
      code: 'unsupported_platform',
    });
    expect(spawned).toHaveLength(0);
  });

  it('reads the home files through PowerShell, a missing one as null', async () => {
    host.reply = (s) =>
      s.stdin.includes("'runtime.json'")
        ? { code: 1, stdout: '{"port":7999,"pid":4}', stderr: 'puddle-exit:0\n' }
        : { code: 1, stderr: 'puddle-exit:2\n' };
    const ssh = new SshTransport('alice@winbox', { platform: 'linux', remotePlatform: 'win32' });
    expect(await ssh.readFile(hostPaths.runtime)).toBe('{"port":7999,"pid":4}');
    expect(await ssh.readFile(hostPaths.supervisor)).toBeNull();
    expect(spawned.every(isProbe)).toBe(true);
  });

  it('takes an operation’s status from the trailer, which a PowerShell shell would collapse', async () => {
    host.reply = () => ({ code: 1, stdout: 'out', stderr: 'note\npuddle-exit:42\n' });
    const ssh = new SshTransport('alice@winbox', { platform: 'linux', remotePlatform: 'win32' });
    expect(await ssh.execWindows('$global:PuddleExit = 42', { payload: 'data' })).toEqual({
      code: 42,
      stdout: 'out',
      stderr: 'note',
    });
    expect(spawned[0]!.stdin.endsWith('data')).toBe(true);
  });

  it('reports a control channel’s own status as it ends, keeping stderr out of it', async () => {
    host.reply = () => ({ code: 1, stdout: '', stderr: 'diagnostics\npuddle-exit:3\n' });
    const ssh = new SshTransport('alice@winbox', { platform: 'linux', remotePlatform: 'win32' });
    let read = '';
    const status = await new Promise((resolve) => {
      const channel = ssh.openWindowsChannel('$global:PuddleExit = 3', { onExit: resolve });
      channel.on('data', (chunk: Buffer) => (read += chunk.toString()));
      channel.on('error', () => {});
      channel.end();
    });
    expect(status).toBe(3);
    expect(read).toBe('');
  });

  it('marks an operation whose loader never reported its status as incomplete', async () => {
    host.reply = () => ({ code: 255, stderr: 'Connection to winbox closed.\n' });
    const ssh = new SshTransport('alice@winbox', { platform: 'linux', remotePlatform: 'win32' });
    expect(await ssh.execWindows('$global:PuddleExit = 0')).toEqual({
      code: 255,
      stdout: '',
      stderr: 'Connection to winbox closed.\n',
      incomplete: true,
    });
  });
});
