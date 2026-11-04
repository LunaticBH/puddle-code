import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SshTransport, type SshOptions } from '../../src/lib/transport/ssh.js';

const spawned = vi.hoisted(() => [] as Array<{ file: string; options: SpawnOptions }>);

// Every ssh/scp child goes through spawnClient; record its options and exit 0.
vi.mock('../../src/lib/transport/spawn.js', () => ({
  spawnClient: (file: string, _args: string[], options: SpawnOptions) => {
    spawned.push({ file, options });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  },
}));

async function spawnEverything(ssh: SshTransport): Promise<void> {
  await ssh.open();
  await ssh.isAlive();
  await ssh.cancelForward(4100, 4200);
  await ssh.exec('true');
  await ssh.runAttached('true').result;
  await ssh.copyTo('local.tar.gz', '/tmp/puddle/remote.tar.gz');
  const channel = ssh.openChannel('true');
  channel.on('error', () => {}); // the channel aborts once its child exits
  await new Promise((resolve) => channel.once('close', resolve));
}

/**
 * Windows gives a hidden child no console (CREATE_NO_WINDOW once no stdio is
 * inherited), so it cannot prompt: only a client without a terminal of its
 * own hides its ssh and scp children, and then every one of them.
 */
describe('which ssh and scp children start without a console window', () => {
  const savedHome = process.env.PUDDLE_HOME;
  beforeAll(() => {
    process.env.PUDDLE_HOME = join(mkdtempSync(join(tmpdir(), 'puddle-ssh-spawn-')), '.puddle');
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.PUDDLE_HOME;
    else process.env.PUDDLE_HOME = savedHome;
  });
  beforeEach(() => {
    spawned.length = 0;
  });

  const clients: Array<[string, SshOptions, boolean]> = [
    ['the terminal CLI, which may prompt on its console', {}, false],
    ['a Windows background cockpit (batch mode)', { batchMode: true }, true],
    ['a graphical embedder with an askpass helper', { askpassProgram: 'askpass.exe' }, true],
  ];

  for (const platform of ['win32', 'darwin'] as const) {
    for (const [client, options, hidden] of clients) {
      it(`${hidden ? 'hides' : 'keeps'} them for ${client} (${platform} argv)`, async () => {
        const ssh = new SshTransport('alice@devbox', { ...options, platform });
        expect(ssh.hidesWindows).toBe(hidden);
        await spawnEverything(ssh);
        expect(spawned.map((child) => child.file)).toContain('scp');
        // The ControlMaster checks spawn only where there is a master.
        expect(spawned).toHaveLength(platform === 'win32' ? 6 : 8);
        for (const child of spawned) {
          expect(child.options.windowsHide).toBe(hidden ? true : undefined);
        }
      });
    }
  }
});
