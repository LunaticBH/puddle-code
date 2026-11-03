import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../../../daemon/test/helpers/authorised-daemon.js';
import { connectRemote } from '../../src/lib/connection/connect.js';
import { findFreePort } from '../../src/lib/transport/net.js';
import type { RunningCockpit } from '../../src/lib/connection/cockpit.js';
import { SshTransport } from '../../src/lib/transport/ssh.js';

const FAKE_SSH = join(dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'fake-ssh.mjs');

function withAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-cli-assets-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>puddle</title>');
  return dir;
}

describe('SshTransport argv shapes', () => {
  it('uses ControlMaster multiplexing on POSIX clients', () => {
    const ssh = new SshTransport('alice@devbox', { platform: 'darwin' });
    const argv = ssh.args('alice@devbox', 'true').join(' ');
    expect(argv).toContain('ControlMaster=auto');
    expect(argv).toContain('ControlPersist=10m');
    expect(argv).toContain('cm-%C');
  });

  it('keeps the connection alive so idle NAT drops cannot fell the tunnel', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const argv = new SshTransport('alice@devbox', { platform }).args('true').join(' ');
      expect(argv).toContain('ServerAliveInterval=15');
      expect(argv).toContain('ServerAliveCountMax=3');
    }
  });

  it('drops every Control* option on Windows (no multiplexing there)', () => {
    const ssh = new SshTransport('alice@devbox', { platform: 'win32' });
    expect(ssh.args('alice@devbox', 'true').join(' ')).not.toContain('Control');
    expect(ssh.hasControlMaster).toBe(false);
  });

  it('forces an embedder-supplied askpass helper without changing the CLI default', () => {
    const graphical = new SshTransport('alice@devbox', {
      platform: 'darwin',
      askpassProgram: '/tmp/puddle-askpass',
    });
    expect(graphical.spawnEnv()).toMatchObject({
      SSH_ASKPASS: '/tmp/puddle-askpass',
      SSH_ASKPASS_REQUIRE: 'force',
      PUDDLE_DESKTOP_SSH_TARGET: 'alice@devbox',
    });
    expect(graphical.spawnEnv()?.DISPLAY).toBeTruthy();

    expect(new SshTransport('alice@devbox', { platform: 'darwin' }).spawnEnv()).toBeUndefined();
  });
});

describe('puddle launch against a fake ssh + real daemon (SSH mode)', () => {
  const fakeClientHome = mkdtempSync(join(tmpdir(), 'puddle-cli-client-'));
  const fakeHostHome = mkdtempSync(join(tmpdir(), 'puddle-cli-hosthome-'));
  const hostPuddle = join(fakeHostHome, '.puddle');
  const killFile = join(fakeHostHome, 'kill-tunnel');
  let daemon: RunningDaemon;
  let cockpit: RunningCockpit;
  let daemonPort: number;
  let credential: string;

  beforeAll(async () => {
    chmodSync(FAKE_SSH, 0o755);
    process.env.FAKE_SSH_HOME = fakeHostHome;
    process.env.FAKE_SSH_KILL = killFile;
    // The CLIENT ~/.puddle (control sockets) must not collide with the host's.
    process.env.PUDDLE_HOME = join(fakeClientHome, '.puddle');

    // A "remote" daemon: pre-installed under the fake host home, on a fixed
    // port recorded in its config.json — exactly what connect discovers.
    daemonPort = await findFreePort();
    mkdirSync(hostPuddle, { recursive: true, mode: 0o700 });
    writeFileSync(join(hostPuddle, 'config.json'), JSON.stringify({ port: daemonPort }) + '\n');
    daemon = await startDaemon({ home: hostPuddle, adapters: [], version: 'remote-test' });
    mkdirSync(join(hostPuddle, 'bin', 'versions', '9.9.9'), { recursive: true });
    mkdirSync(join(hostPuddle, 'bin', 'versions', '9.9.9', 'bin'));
    symlinkSync(process.execPath, join(hostPuddle, 'bin', 'versions', '9.9.9', 'bin', 'node'));
    symlinkSync('versions/9.9.9', join(hostPuddle, 'bin', 'current'));

    cockpit = await connectRemote({
      host: 'alice@devbox',
      assetsDir: withAssets(),
      sshBinary: FAKE_SSH,
      platform: 'darwin',
    });
    const invite = new URLSearchParams(new URL(cockpit.createInvitation()).hash.slice(1)).get(
      'invite',
    );
    const response = await fetch(cockpit.origin + '/cockpit/bootstrap', {
      method: 'POST',
      headers: { origin: cockpit.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ invitation: invite }),
    });
    credential = ((await response.json()) as { credential: string }).credential;
  }, 30_000);

  afterAll(async () => {
    await cockpit?.stop();
    await daemon?.stop();
    delete process.env.FAKE_SSH_HOME;
    delete process.env.FAKE_SSH_KILL;
    delete process.env.PUDDLE_HOME;
  });

  const viaCockpit = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${cockpit.origin}${path}`, { headers });

  it('lands a working cockpit: UI + proxied API through the tunnel', async () => {
    expect(daemonPort).toBe(daemon.port); // config.json really drove the bind
    expect(await (await viaCockpit('/')).text()).toContain('puddle');
    const version = await viaCockpit('/api/version', {
      authorization: `Bearer ${credential}`,
    });
    expect(version.status).toBe(200);
    expect(((await version.json()) as { version: string }).version).toBe('remote-test');
  });

  it('creates fresh, independent browser invitations', () => {
    const one = cockpit.createInvitation();
    const two = cockpit.createInvitation();
    expect(one).not.toBe(two);
    expect(one).toContain(`#invite=iv_`);
    expect(one).not.toContain(daemon.token);
  });

  it('reconnects the tunnel after it drops, on the same local port', async () => {
    const events: string[] = [];
    cockpit.onEvent((e) => events.push(e.t));
    writeFileSync(killFile, ''); // the fake forward exits when this appears
    await waitUntil(() => events.includes('tunnel-down'), 5000);
    rmSync(killFile); // let the respawn survive
    await waitUntil(() => events.includes('tunnel-up'), 15_000);
    for (let n = 0; n < 100; n++) {
      const status = await viaCockpit('/cockpit/status', { authorization: `Bearer ${credential}` });
      if (((await status.json()) as { upstream: string }).upstream === 'ready') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const version = await viaCockpit('/api/version', {
      authorization: `Bearer ${credential}`,
    });
    expect(version.status).toBe(200);
  }, 25_000);
});

async function waitUntil(cond: () => boolean, ms: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
