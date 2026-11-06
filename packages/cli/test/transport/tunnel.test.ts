import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findFreePort, tcpListening } from '../../src/lib/transport/net.js';
import {
  netstatListens,
  openCallbackForward,
  openTunnel,
  windowsLoopbackListening,
  type Tunnel,
} from '../../src/lib/transport/tunnel.js';
import { SshTransport } from '../../src/lib/transport/ssh.js';
import type { CliEvent } from '../../src/lib/types.js';
import { fakeSshBinary } from '../helpers/fake-ssh.js';

let FAKE_SSH: string;
// The full suite runs many process-heavy integration tests in parallel. Keep
// this test's deliberately-silent outage inside a generous TEST grace even
// when the fake SSH child is starved; production's two-second grace is
// unchanged. We still wait beyond this value below, proving the timer clears.
const TEST_DOWN_GRACE_MS = 10_000;

/**
 * Outage announcements — tunnel-down/tunnel-up are meant to describe outages
 * the user should know about, not every child exit (a blip that respawns on
 * the first attempt stays silent; a drop right after a restore is flapping
 * and is announced at once).
 */
describe('tunnel outage announcements', () => {
  const clientHome = mkdtempSync(join(tmpdir(), 'puddle-tunnel-client-'));
  const killFile = join(clientHome, 'kill-tunnel');
  let upstream: Server;
  let upstreamPort: number;
  let tunnel: Tunnel | null = null;

  beforeAll(async () => {
    FAKE_SSH = fakeSshBinary();
    process.env.PUDDLE_HOME = join(clientHome, '.puddle');
    process.env.FAKE_SSH_KILL = killFile;
    // A stand-in for the remote daemon port the forward points at.
    upstreamPort = await findFreePort();
    upstream = createServer((sock) => {
      // A forward killed mid-connection resets it (TerminateProcess on Windows).
      sock.on('error', () => {});
      sock.end();
    });
    await new Promise<void>((r) => upstream.listen(upstreamPort, '127.0.0.1', r));
  });

  afterEach(async () => {
    await tunnel?.close();
    tunnel = null;
    rmSync(killFile, { force: true });
  });

  afterAll(async () => {
    await new Promise((r) => upstream.close(r));
    delete process.env.PUDDLE_HOME;
    delete process.env.FAKE_SSH_KILL;
  });

  const open = async () => {
    const ssh = new SshTransport('alice@devbox', { platform: 'darwin', sshBinary: FAKE_SSH });
    const t = await openTunnel(ssh, upstreamPort, {
      sshBinary: FAKE_SSH,
      downGraceMs: TEST_DOWN_GRACE_MS,
    });
    tunnel = t;
    const events: CliEvent['t'][] = [];
    t.onEvent((e) => events.push(e.t));
    return { tunnel: t, events };
  };

  /** Drop the forward and let it respawn cleanly (fake-ssh exits on killFile). */
  const dropOnce = async (t: Tunnel) => {
    writeFileSync(killFile, '');
    await waitUntil(async () => !(await tcpListening(t.localPort)), 5000);
    rmSync(killFile);
    await waitUntil(() => tcpListening(t.localPort), 15_000);
  };

  it('says nothing about an outage that heals inside the grace window', async () => {
    const { tunnel: t, events } = await open();
    await dropOnce(t);
    // Give any stray grace timer time to (wrongly) fire before asserting.
    await new Promise((r) => setTimeout(r, TEST_DOWN_GRACE_MS + 500));
    expect(events).toEqual([]);
    expect(await tcpListening(t.localPort)).toBe(true);
  }, 40_000);

  it('announces immediately when the tunnel flaps, and pairs the restore', async () => {
    const { tunnel: t, events } = await open();
    await dropOnce(t); // silent first blip; the next drop counts as flapping
    writeFileSync(killFile, '');
    await waitUntil(() => events.includes('tunnel-down'), 15_000);
    rmSync(killFile);
    await waitUntil(() => events.includes('tunnel-up'), 20_000);
    expect(events).toEqual(['tunnel-down', 'tunnel-up']);
  }, 50_000);

  // The forward binding its local port is not proof it carries traffic — a
  // non-OpenSSH server can leave a listener that never reaches the daemon.
  // Readiness therefore hangs on the end-to-end probe, not the TCP bind.
  it('rejects a forward whose end-to-end probe never passes, though the local port is up', async () => {
    const ssh = new SshTransport('alice@devbox', { platform: 'darwin', sshBinary: FAKE_SSH });
    await expect(
      openTunnel(ssh, upstreamPort, { sshBinary: FAKE_SSH, ready: async () => false }),
    ).rejects.toThrow(/could not open a tunnel/);
  }, 20_000);

  it('opens once the end-to-end probe passes', async () => {
    const ssh = new SshTransport('alice@devbox', { platform: 'darwin', sshBinary: FAKE_SSH });
    const t = await openTunnel(ssh, upstreamPort, { sshBinary: FAKE_SSH, ready: async () => true });
    tunnel = t;
    expect(await tcpListening(t.localPort)).toBe(true);
  }, 20_000);
});

/**
 * Codex's fixed-port callback forward: nothing listens on the host's end
 * until a login runs there, so every connection through it is a channel the
 * host refuses, which a Windows client's ssh reports on the user's terminal.
 */
describe('the agent OAuth callback forward', () => {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-callback-forward-'));
  const accepted = join(dir, 'accepted');
  const listeningFile = join(dir, 'listening');
  let fakeSsh: string;
  const lines = (file: string) =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  /** The fake forwarder's own word that it listens: looking connects to nothing. */
  const listening = async (port: number) => lines(listeningFile).includes(String(port));

  beforeAll(() => {
    fakeSsh = fakeSshBinary();
    process.env.PUDDLE_HOME = join(dir, '.puddle');
    process.env.FAKE_SSH_ACCEPTED = accepted;
    process.env.FAKE_SSH_LISTENING = listeningFile;
  });
  afterEach(() => {
    rmSync(accepted, { force: true });
    rmSync(listeningFile, { force: true });
  });
  afterAll(() => {
    delete process.env.PUDDLE_HOME;
    delete process.env.FAKE_SSH_ACCEPTED;
    delete process.env.FAKE_SSH_LISTENING;
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds a Windows client’s forward without connecting through it', async () => {
    const port = await findFreePort();
    const ssh = new SshTransport('alice@winbox', { platform: 'win32', sshBinary: fakeSsh });
    const close = await openCallbackForward(ssh, port, { sshBinary: fakeSsh, listening });
    expect(close).not.toBeNull();
    expect(lines(listeningFile)).toEqual([String(port)]);
    // Long enough for the forwarder to record a connection made while it came up.
    await new Promise((r) => setTimeout(r, 500));
    expect(lines(accepted)).toEqual([]);
    await close!();
  }, 20_000);

  it('gives up at once on a Windows client whose forwarding ssh has exited', async () => {
    const kill = join(dir, 'kill');
    writeFileSync(kill, '');
    process.env.FAKE_SSH_KILL = kill;
    try {
      const warnings: string[] = [];
      const ssh = new SshTransport('alice@winbox', { platform: 'win32', sshBinary: fakeSsh });
      const started = Date.now();
      const close = await openCallbackForward(ssh, await findFreePort(), {
        sshBinary: fakeSsh,
        listening: async () => false,
        logger: { info: () => {}, warn: (message) => warnings.push(message) },
      });
      expect(close).toBeNull();
      expect(Date.now() - started).toBeLessThan(4500);
      expect(warnings.join('\n')).toContain('forward did not come up');
    } finally {
      delete process.env.FAKE_SSH_KILL;
      rmSync(kill, { force: true });
    }
  }, 20_000);

  it('still finds a Linux or macOS client’s forward by connecting to it', async () => {
    // The master holds the forward there, and what it reports goes nowhere.
    const port = await findFreePort();
    const ssh = new SshTransport('alice@devbox', { platform: 'linux', sshBinary: fakeSsh });
    const close = await openCallbackForward(ssh, port, { sshBinary: fakeSsh, listening });
    expect(close).not.toBeNull();
    await waitUntil(() => lines(accepted).length > 0, 5000);
    await close!();
  }, 20_000);

  it('reads a listener from netstat by its foreign address, whatever the language', () => {
    const netstat = [
      '',
      'Aktive Verbindungen',
      '',
      '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN          1100',
      '  TCP    127.0.0.1:1455         0.0.0.0:0              ABHÖREN          4242',
      '  TCP    127.0.0.1:2000         127.0.0.1:1455         HERGESTELLT      4242',
      '  TCP    [::1]:3000             [::]:0                 ABHÖREN          4343',
      '',
    ].join('\r\n');
    expect(netstatListens(netstat, 1455)).toBe(true);
    expect(netstatListens(netstat, 135)).toBe(true);
    // An established connection and an IPv6-only listener are not 127.0.0.1 listeners.
    expect(netstatListens(netstat, 2000)).toBe(false);
    expect(netstatListens(netstat, 3000)).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'sees a loopback listener on Windows, and its absence',
    async () => {
      const server = createServer();
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address() as { port: number };
      expect(await windowsLoopbackListening(port)).toBe(true);
      await new Promise((r) => server.close(r));
      expect(await windowsLoopbackListening(port)).toBe(false);
    },
    20_000,
  );
});

async function waitUntil(cond: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
