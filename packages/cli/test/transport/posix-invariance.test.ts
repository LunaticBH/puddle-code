import type { SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

/**
 * Every command a POSIX host receives, pinned byte for byte (docs/windows.md,
 * decision 1): the Windows-host support may add commands only after a failed
 * `true`, never change one a POSIX host already gets. Each ssh/scp child is
 * recorded through the spawnClient seam and answered as a healthy POSIX
 * host would answer it.
 */

interface Recorded {
  file: string;
  args: string[];
  stdin: string;
}
const recorded = vi.hoisted(() => [] as Recorded[]);
const reply = vi.hoisted(() => ({
  current: (_args: string[]): { code: number; stdout?: string } => ({ code: 0 }),
}));

vi.mock('../../src/lib/transport/spawn.js', () => ({
  spawnClient: (file: string, args: string[], options: SpawnOptions) => {
    const entry = { file, args, stdin: '' };
    recorded.push(entry);
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        setImmediate(() => child.emit('close', null));
        return true;
      },
    });
    const finish = () => {
      const answer = reply.current(args);
      if (answer.stdout !== undefined) child.stdout.write(answer.stdout);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', answer.code));
    };
    const piped = Array.isArray(options.stdio) && options.stdio[0] === 'pipe';
    const channel = args.includes('-T');
    stdin.on('data', (chunk: Buffer) => (entry.stdin += chunk.toString()));
    if (channel) return child;
    if (piped) stdin.on('finish', finish);
    else setImmediate(finish);
    stdin.resume();
    return child;
  },
}));

import { inspectHost, openControlChannel } from '../../src/lib/auth/control-channel.js';
import { readDaemonPort } from '../../src/lib/connection/daemon-client.js';
import { RemoteAccessControl } from '../../src/lib/host/remote-access.js';
import {
  installDaemon,
  installedVersion,
  readInstallScript,
} from '../../src/lib/installation/bootstrap.js';
import { removeDaemon, sweepDirtyWorktrees } from '../../src/lib/installation/remove-daemon.js';
import { showLogs } from '../../src/lib/logs.js';
import { hostPaths } from '../../src/lib/paths.js';
import { SshTransport } from '../../src/lib/transport/ssh.js';
import { runRemote } from '../../src/cli/remote.js';

const saved = { home: process.env.PUDDLE_HOME, repo: process.env.PUDDLE_REPO };
let clientHome: string;
let tarball: string;
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-posix-invariance-'));
  clientHome = join(dir, '.puddle');
  process.env.PUDDLE_HOME = clientHome;
  process.env.PUDDLE_REPO = 'acme/puddle';
  tarball = join(dir, 'puddled-v1.2.3-linux-x64.tar.gz');
  writeFileSync(tarball, 'archive');
  writeFileSync(`${tarball}.sha256`, 'sums');
});
afterAll(() => {
  for (const [name, value] of [
    ['PUDDLE_HOME', saved.home],
    ['PUDDLE_REPO', saved.repo],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A healthy POSIX host's answer to each command. */
function posixHost(args: string[]): { code: number; stdout?: string } {
  const command = args.at(-1) ?? '';
  if (command.includes('readlink ')) return { code: 0, stdout: 'versions/1.2.3\n' };
  if (command.includes('--inspect') && command.includes('connector.mjs'))
    return {
      code: 0,
      stdout: JSON.stringify({
        configured: false,
        enabled: false,
        connected: false,
        supervisor: null,
        devices: [],
      }),
    };
  if (command.includes('connector.mjs --version'))
    return { code: 0, stdout: 'puddle-connector 1.2.3 cockpit controls 2 delete registration 1' };
  if (command.includes('connector.mjs --admin'))
    return { code: 0, stdout: JSON.stringify({ enabled: true, connected: false, devices: [] }) };
  if (command.includes(' --inspect'))
    return { code: 0, stdout: '{"t":"error","code":"unavailable"}' };
  if (command.includes('cat ')) return { code: 0, stdout: '{"port":7999}' };
  return { code: 0 };
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** `-o ControlMaster=…`, `-o ControlPath=…` and `-o ControlPersist=…`, in place. */
function withoutControlMaster(args: string[]): string[] {
  return args.filter(
    (arg, i) => !/^Control(Master|Path|Persist)=/.test(arg) && !/^Control/.test(args[i + 1] ?? ''),
  );
}

function normalise(
  entries: Recorded[],
  // `puddle remote` opens its own transport, with or without a master by the client's OS.
  clientNeutral = false,
): Array<{ file: string; args: string[]; stdin?: string }> {
  // install.sh and the bundled helper are pinned by their own tests; the
  // scripts written here inline are pinned by digest.
  const installer = readInstallScript();
  return entries.map(({ file, args: given, stdin }) => {
    const args = clientNeutral ? withoutControlMaster(given) : given;
    const clean = (text: string) =>
      text
        .replaceAll(clientHome, '<client-home>')
        .replaceAll(tarball, '<tarball>')
        .replace(/helper-[0-9a-f]+\.mjs/g, 'helper-<digest>.mjs');
    const helper = args.some((arg) => arg.includes('fs.renameSync(tmp, dest)'));
    const named = helper ? '<host-control helper>' : stdin === installer ? '<install.sh>' : null;
    return {
      file,
      args: args.map(clean),
      ...(stdin === '' ? {} : { stdin: named ?? digest(stdin) }),
    };
  });
}

it('sends a POSIX host exactly the commands it always received', async () => {
  reply.current = posixHost;
  recorded.length = 0;
  const ssh = new SshTransport('alice@devbox', { platform: 'linux' });
  const steps: Record<string, Array<{ file: string; args: string[]; stdin?: string }>> = {};
  const step = async (name: string, run: () => Promise<unknown>) => {
    recorded.length = 0;
    await run();
    steps[name] = normalise(recorded, name === 'puddle remote devices');
  };

  await step('open', () => ssh.open());
  await step('isAlive', () => ssh.isAlive());
  await step('cancelForward', () => ssh.cancelForward(4100, 4200));
  await step('installedVersion', () => installedVersion(ssh));
  await step('install from releases', () => installDaemon(ssh, { version: '1.2.3' }));
  await step('install a tarball', () => installDaemon(ssh, { tarball, version: '1.2.3' }));
  await step('sweep', () => sweepDirtyWorktrees(ssh));
  await step('remove', () => removeDaemon(ssh, { purge: false }));
  await step('remove --purge', () => removeDaemon(ssh, { purge: true }));
  await step('session log', () => showLogs(ssh, { session: 's1', write: () => {} }));
  await step('session log --follow', () =>
    showLogs(ssh, { session: 's1', term: 'shell', follow: true, write: () => {} }),
  );
  await step('daemon log', () => showLogs(ssh, { write: () => {} }));
  await step('inspect', () => inspectHost(ssh));
  await step('control channel', async () => {
    const channel = await openControlChannel(ssh);
    channel.on('error', () => {});
    channel.destroy();
  });
  await step('daemon port', () => readDaemonPort(ssh));
  await step('read the supervisor marker', () => ssh.readFile(hostPaths.supervisor));
  await step('run attached', async () => {
    const running = ssh.runAttached('exec puddled');
    await running.result;
  });
  await step('remote access status', () => new RemoteAccessControl(ssh).status('0123456789'));
  await step('puddle remote devices', () =>
    runRemote({
      cmd: 'remote',
      action: 'devices',
      host: 'alice@devbox',
      profile: '0123456789',
      foreground: false,
    }),
  );

  await expect(JSON.stringify(steps, null, 2) + '\n').toMatchFileSnapshot(
    './__snapshots__/posix-commands.json',
  );
});
