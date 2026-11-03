import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../../../daemon/test/helpers/authorised-daemon.js';
import { ensureDaemon } from '../../src/lib/connection/cockpit.js';
import { findFreePort } from '../../src/lib/transport/net.js';
import { startUiServer } from '../../src/lib/serve/ui-server.js';
import { LocalTransport } from '../../src/lib/transport/local.js';
import type { ExecResult, Transport } from '../../src/lib/transport/transport.js';

describe('ensureDaemon identity probe', () => {
  let daemon: RunningDaemon;
  let daemonPort: number;

  beforeAll(async () => {
    daemonPort = await findFreePort();
    const homeA = mkdtempSync(join(tmpdir(), 'puddle-cockpit-a-'));
    // Exercise startup and authenticated readiness from an actual legacy mode.
    chmodSync(homeA, 0o755);
    writeFileSync(join(homeA, 'config.json'), JSON.stringify({ port: daemonPort }) + '\n');
    daemon = await startDaemon({ home: homeA, adapters: [], version: 'identity-test' });
  });
  afterAll(async () => {
    await daemon.stop();
    delete process.env.PUDDLE_HOME;
  });

  // The legacy token-and-port probe exists only for pre-pipe POSIX releases;
  // Windows finds its daemon solely through the home's private pipe.
  it.skipIf(process.platform === 'win32')(
    "refuses to treat a daemon that rejects this host's token as ours",
    async () => {
      // Home B: a different token, but config points at daemon A's port — the
      // shape of the port-collision incident (another cockpit or foreign
      // daemon answering on the expected port).
      const homeB = mkdtempSync(join(tmpdir(), 'puddle-cockpit-b-'));
      mkdirSync(join(homeB, '.puddle'), { recursive: true, mode: 0o700 });
      writeFileSync(join(homeB, '.puddle', 'token'), 'b'.repeat(64) + '\n');
      writeFileSync(
        join(homeB, '.puddle', 'config.json'),
        JSON.stringify({ port: daemonPort, configVersion: 2 }) + '\n',
      );
      process.env.PUDDLE_HOME = join(homeB, '.puddle');

      await expect(ensureDaemon(new LocalTransport(), {})).rejects.toMatchObject({
        code: 'port_in_use',
        message: expect.stringContaining('rejects its local'),
      });
    },
  );

  it("accepts the daemon when the token matches (probe = 'ok')", async () => {
    process.env.PUDDLE_HOME = daemon.paths.home;
    const endpoint = await ensureDaemon(new LocalTransport(), {});
    expect(endpoint).toMatchObject({ port: daemonPort, bootstrapped: false });
    expect(endpoint.authority.credential()).toMatch(/^cn_/);
    endpoint.authority.close();
  });
});

describe('UI server avoids the daemon port', () => {
  it('skips avoidPort during auto-pick even when that port is free', async () => {
    const assets = mkdtempSync(join(tmpdir(), 'puddle-avoid-assets-'));
    writeFileSync(join(assets, 'index.html'), '<!doctype html>');
    const start = await findFreePort();
    const ui = await startUiServer({
      assetsDir: assets,
      identity: 'local',
      authHome: mkdtempSync(join(tmpdir(), 'puddle-avoid-auth-')),
      authority: {
        state: 'ready',
        credential: () => '',
        onChange: () => () => {},
        close() {},
        generation: null,
        resource() {
          throw new Error('not used');
        },
      },
      port: start,
      avoidPort: start, // the daemon's port: must be skipped, not taken
      target: { host: '127.0.0.1', port: 1 },
    });
    expect(ui.port).not.toBe(start);
    expect(ui.port).toBeGreaterThan(start);
    await ui.close();
  });
});

describe('SSH daemon lifetime fallback', () => {
  it('uses an attached daemon only after a nohup child was reaped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-fallback-tarball-'));
    const tarball = join(dir, 'puddled-v0.0.0-linux-x64.tar.gz');
    writeFileSync(tarball, 'test seam');
    const warnings: string[] = [];
    let fallbackStarts = 0;
    const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
    const transport: Transport = {
      kind: 'ssh',
      label: 'alice@devbox',
      async exec(command) {
        if (command.startsWith('kill -0 ')) return { code: 1, stdout: '', stderr: '' };
        return ok(); // install.sh is deliberately not executed by this test seam
      },
      async readFile(path) {
        if (path.endsWith('/supervisor')) return 'nohup\n';
        if (path.endsWith('/puddled.pid')) return '12345\n';
        return null;
      },
      async copyTo() {},
      dispose() {},
    };

    const endpoint = await ensureDaemon(transport, {
      tarball,
      startTimeoutMs: 0,
      logger: { info() {}, warn: (message) => warnings.push(message) },
      attachedFallback: async () => {
        fallbackStarts += 1;
        return {
          port: 7434,
          authority: {} as import('../../src/lib/auth/connection-authority.js').HostConnection,
          bootstrapped: true,
          daemonLifetime: 'cockpit',
          lease: { async ensureRunning() {}, async stop() {} },
        };
      },
    });

    expect(endpoint.daemonLifetime).toBe('cockpit');
    expect(fallbackStarts).toBe(1);
    expect(warnings).toEqual([expect.stringContaining('keeping it attached to this cockpit')]);
  });

  it.each([
    { supervisor: 'systemd', pidAlive: false },
    { supervisor: 'nohup', pidAlive: true },
  ])('refuses the fallback for $supervisor with pidAlive=$pidAlive', async (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-no-fallback-tarball-'));
    const tarball = join(dir, 'puddled-v0.0.0-linux-x64.tar.gz');
    writeFileSync(tarball, 'test seam');
    let fallbackStarts = 0;
    const transport: Transport = {
      kind: 'ssh',
      label: 'alice@devbox',
      async exec(command) {
        if (command.startsWith('kill -0 ')) {
          return { code: scenario.pidAlive ? 0 : 1, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      async readFile(path) {
        if (path.endsWith('/supervisor')) return `${scenario.supervisor}\n`;
        if (path.endsWith('/puddled.pid')) return '12345\n';
        return null;
      },
      async copyTo() {},
      dispose() {},
    };

    await expect(
      ensureDaemon(transport, {
        tarball,
        startTimeoutMs: 0,
        attachedFallback: async () => {
          fallbackStarts += 1;
          throw new Error('must not start');
        },
      }),
    ).rejects.toMatchObject({ code: 'daemon_start_timeout' });
    expect(fallbackStarts).toBe(0);
  });
});
