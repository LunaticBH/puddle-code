import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findFreePort, tcpListening } from '../../src/lib/transport/net.js';
import { openTunnel, type Tunnel } from '../../src/lib/transport/tunnel.js';
import { SshTransport } from '../../src/lib/transport/ssh.js';
import type { CliEvent } from '../../src/lib/types.js';

const FAKE_SSH = join(dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'fake-ssh.mjs');
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
    chmodSync(FAKE_SSH, 0o755);
    process.env.PUDDLE_HOME = join(clientHome, '.puddle');
    process.env.FAKE_SSH_KILL = killFile;
    // A stand-in for the remote daemon port the forward points at.
    upstreamPort = await findFreePort();
    upstream = createServer((sock) => sock.end());
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

async function waitUntil(cond: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
