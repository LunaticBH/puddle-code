import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@puddle/shared';
import { ipcPath } from '@puddle/shared/node';
import { startHostControl } from '../../../daemon/src/security/control.js';
import { LeaseRegistry } from '../../../daemon/src/security/leases.js';
import { inspectHostLocally } from '../../src/lib/auth/host-inspection.js';
import { LocalTransport } from '../../src/lib/transport/local.js';
import type { Transport } from '../../src/lib/transport/transport.js';

const install = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('../../src/lib/installation/bootstrap.js', () => ({
  installDaemon: install,
  installedVersion: async () => '0.2.3',
}));
import { ensureDaemon } from '../../src/lib/connection/cockpit.js';
import { startLocal } from '../../src/lib/connection/start.js';

let home: string;
let major: number;
let server: Server;
let stopControl: () => Promise<void>;
let registry: LeaseRegistry;
let rejectInspection: boolean;
const savedHome = process.env.PUDDLE_HOME;
const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'puddle-upgrade-'));
  process.env.PUDDLE_HOME = home;
  major = PROTOCOL_VERSION.major - 1;
  rejectInspection = false;
  registry = new LeaseRegistry();
  const version = () => ({
    version: major === PROTOCOL_VERSION.major ? '0.2.4' : '0.2.3',
    protocol: { major, minor: 0 },
  });
  server = createServer((req, res) => {
    const token = req.headers.authorization?.slice('Bearer '.length) ?? '';
    if (!registry.valid(token) || (rejectInspection && req.url === '/api/sessions')) {
      res.writeHead(401).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    // Deliberately omit unrelated fields which older session schemas may not carry.
    res.end(
      JSON.stringify(
        req.url === '/api/version'
          ? version()
          : [{ status: 'running' }, { status: 'waiting_input' }, { status: 'exited' }],
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  stopControl = await startHostControl(home, registry, () => ({ port, version: version() }));
  install.mockReset().mockImplementation(async () => {
    major = PROTOCOL_VERSION.major;
  });
});
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  await stopControl();
  registry.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (savedHome === undefined) delete process.env.PUDDLE_HOME;
  else process.env.PUDDLE_HOME = savedHome;
});

function transport(kind: 'local' | 'ssh'): Transport {
  if (kind === 'local') return new LocalTransport();
  return {
    kind: 'ssh',
    label: 'devbox',
    async exec(command) {
      return {
        code: 0,
        stderr: '',
        stdout: command.endsWith('--inspect') ? JSON.stringify(await inspectHostLocally(home)) : '',
      };
    },
    async openChannel() {
      return connect(ipcPath(home, 'host'));
    },
    async readFile() {
      return null;
    },
    async copyTo() {},
    dispose() {},
  };
}

it.each(['local', 'ssh'] as const)(
  'negotiates a modern older host through %s control before installing',
  async (kind) => {
    let approve!: (answer: boolean) => void;
    const confirmDaemonUpgrade = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          approve = resolve;
        }),
    );
    const pending = ensureDaemon(transport(kind), { confirmDaemonUpgrade });
    await vi.waitFor(() => expect(confirmDaemonUpgrade).toHaveBeenCalledOnce());
    expect(confirmDaemonUpgrade.mock.calls[0]?.[0]).toMatchObject({
      liveSessions: 2,
      daemon: { protocol: { major: PROTOCOL_VERSION.major - 1 } },
    });
    expect(install).not.toHaveBeenCalled();
    approve(true);
    const endpoint = await pending;
    cleanup.push(() => endpoint.authority.close());
    expect(endpoint.authority.version?.protocol.major).toBe(PROTOCOL_VERSION.major);
    expect(endpoint.authority.credential()).toMatch(/^cn_/);
    expect(install).toHaveBeenCalledOnce();
  },
);

it('opens the cockpit after one approved update and no second handshake upgrade', async () => {
  writeFileSync(join(home, 'index.html'), '<!doctype html><title>test</title>');
  const confirmDaemonUpgrade = vi.fn(async () => true);
  const cockpit = await startLocal({ assetsDir: home, confirmDaemonUpgrade });
  cleanup.push(() => cockpit.stop());
  expect((await fetch(cockpit.origin)).status).toBe(200);
  expect(cockpit.daemon.protocol.major).toBe(PROTOCOL_VERSION.major);
  expect(confirmDaemonUpgrade).toHaveBeenCalledOnce();
  expect(install).toHaveBeenCalledOnce();
});

it.each(['declined', 'missing', 'no-upgrade', 'newer', 'compatible'] as const)(
  'leaves the daemon alone when %s',
  async (mode) => {
    if (mode === 'newer') major = PROTOCOL_VERSION.major + 1;
    if (mode === 'compatible') major = PROTOCOL_VERSION.major;
    const confirmDaemonUpgrade = vi.fn(async () => false);
    const pending = ensureDaemon(new LocalTransport(), {
      noUpgrade: mode === 'no-upgrade',
      confirmDaemonUpgrade: mode === 'missing' ? undefined : confirmDaemonUpgrade,
    });
    if (mode === 'compatible') {
      const endpoint = await pending;
      endpoint.authority.close();
    } else {
      await expect(pending).rejects.toMatchObject({
        code: mode === 'newer' ? 'cli_outdated' : 'upgrade_failed',
      });
    }
    expect(install).not.toHaveBeenCalled();
    expect(confirmDaemonUpgrade).toHaveBeenCalledTimes(mode === 'declined' ? 1 : 0);
  },
);

it('does not bootstrap blindly when inspection of a known mismatch fails', async () => {
  rejectInspection = true;
  const confirmDaemonUpgrade = vi.fn(async () => true);
  await expect(ensureDaemon(new LocalTransport(), { confirmDaemonUpgrade })).rejects.toThrow(
    'inspection rejected',
  );
  expect(confirmDaemonUpgrade).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
});

it('reports an incompatible replacement without prompting or installing again', async () => {
  install.mockImplementation(async () => {});
  const confirmDaemonUpgrade = vi.fn(async () => true);
  await expect(ensureDaemon(new LocalTransport(), { confirmDaemonUpgrade })).rejects.toMatchObject({
    code: 'upgrade_failed',
  });
  expect(confirmDaemonUpgrade).toHaveBeenCalledOnce();
  expect(install).toHaveBeenCalledOnce();
});

it.each([0, 1])('rechecks a host changed during the prompt (major offset %i)', async (offset) => {
  const confirmDaemonUpgrade = vi.fn(async () => {
    major = PROTOCOL_VERSION.major + offset;
    return true;
  });
  const pending = ensureDaemon(new LocalTransport(), { confirmDaemonUpgrade });
  if (offset === 0) {
    const endpoint = await pending;
    endpoint.authority.close();
  } else {
    await expect(pending).rejects.toMatchObject({ code: 'cli_outdated' });
  }
  expect(confirmDaemonUpgrade).toHaveBeenCalledOnce();
  expect(install).not.toHaveBeenCalled();
});
