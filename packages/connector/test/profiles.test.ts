import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { atomicPrivateJson, ipcPath, listenPrivate } from '@puddle/shared/node';
import { createIdentity, identityPeer } from '@puddle/remote-transport';
import { startConnectorManager } from '../src/manager.js';
import { configureConnector, administrativeRequest, resetConnectorIdentity } from '../src/admin.js';
import { profileDirectory } from '../src/profile-state.js';
import { inspectConnector } from '../src/inspect.js';
import { DeviceStore } from '../src/devices.js';

const one = 'a'.repeat(10);
const two = 'b'.repeat(10);
const config = (account: string) => ({
  host: crypto.randomUUID(),
  account,
  credential: (account === 'one' ? 'a' : 'b').repeat(64),
  enabled: false,
  service: 'https://relay.example.test',
  app: 'https://app.example.test',
});
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});
function home() {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-profile-registrations-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  return directory;
}

it('keeps two accounts, invitations, approvals and recovery independent on one host', async () => {
  const directory = home();
  for (const [profile, account] of [
    [one, 'one'],
    [two, 'two'],
  ]) {
    atomicPrivateJson(join(profileDirectory(directory, profile!), 'config.json'), config(account!));
  }
  const manager = await startConnectorManager(directory);
  cleanups.push(() => manager.close());
  const first = await inspectConnector(directory, one);
  const second = await inspectConnector(directory, two);
  // The second profile's endpoint must survive the first one's recovery. A
  // Unix socket proves it by inode; a Windows pipe has no identity to stat (a
  // stat opens it as a client), so there the live status request below does.
  const secondSocket = ipcPath(directory, `remote-${two}`);
  const secondInode = process.platform === 'win32' ? 0 : statSync(secondSocket).ino;
  expect(first.host).not.toBe(second.host);
  expect(first.peer).not.toBe(second.peer);
  const devicesOne = new DeviceStore(profileDirectory(directory, one));
  const devicesTwo = new DeviceStore(profileDirectory(directory, two));
  cleanups.push(() => {
    devicesOne.close();
    devicesTwo.close();
  });
  const peer = identityPeer(await createIdentity());
  const invitation = devicesOne.invite();
  expect(() => devicesTwo.enrol(invitation.invitation, peer, 'two', 'Wrong profile')).toThrow();
  const d1 = devicesOne.enrol(invitation.invitation, peer, 'one', 'First browser');
  const d2 = devicesTwo.enrol(devicesTwo.invite().invitation, peer, 'two', 'Second browser');
  await administrativeRequest(directory, { t: 'approve', id: d1.id }, one);
  await administrativeRequest(directory, { t: 'approve', id: d2.id }, two);
  expect(
    (await administrativeRequest(directory, { t: 'approve', id: d1.id }, two)).error,
  ).toBeDefined();
  await administrativeRequest(directory, { t: 'revoke', id: d1.id }, one);
  expect(devicesTwo.valid(d2.id, peer, 'two')).toBe(true);
  await resetConnectorIdentity(directory, one);
  await vi.waitFor(
    async () => {
      const current = await administrativeRequest(directory, { t: 'status' }, one);
      expect(current.peer).toBe((await inspectConnector(directory, one)).peer);
    },
    { timeout: 3000 },
  );
  if (process.platform !== 'win32') expect(statSync(secondSocket).ino).toBe(secondInode);
  expect((await administrativeRequest(directory, { t: 'status' }, two)).host).toBe(second.host);
  expect((await inspectConnector(directory, two)).peer).toBe(second.peer);
  await administrativeRequest(directory, { t: 'delete_registration' }, one);
  expect((await inspectConnector(directory, one)).configured).toBe(false);
  expect((await inspectConnector(directory, two)).host).toBe(second.host);
  expect(devicesTwo.valid(d2.id, peer, 'two')).toBe(true);
});

it('can enable another profile while the first registration is enabled', async () => {
  const directory = home();
  const responses = [config('one'), config('two')];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const { host, account, credential } = responses.shift()!;
      return Response.json({ host, account, credential });
    }),
  );
  const setup = {
    service: 'https://relay.example.test',
    app: 'https://app.example.test',
    code: 'c'.repeat(64),
    managed: false,
  };
  await configureConnector(directory, setup, one);
  await configureConnector(directory, setup, two);
  for (const profile of [one, two])
    expect((await inspectConnector(directory, profile)).enabled).toBe(true);
  await administrativeRequest(directory, { t: 'disable' }, one);
  expect((await inspectConnector(directory, two)).enabled).toBe(true);
});

it('deletes legacy registrations, revokes their browsers, and retires the relay record', async () => {
  const directory = home();
  chmodSync(directory, 0o755); // Owned legacy homes are tightened before authority access.
  const legacy = join(directory, 'remote');
  const old = { ...config('one'), enabled: true };
  atomicPrivateJson(join(legacy, 'config.json'), old);
  const devices = new DeviceStore(legacy);
  const peer = identityPeer(await createIdentity());
  const device = devices.enrol(devices.invite().invitation, peer, 'one', 'Legacy browser');
  devices.approve(device.id);
  devices.close();
  const manager = await startConnectorManager(directory);
  cleanups.push(() => manager.close());
  if (process.platform !== 'win32') expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(existsSync(join(legacy, 'config.json'))).toBe(false);
  const migrated = new DeviceStore(legacy);
  try {
    expect(migrated.list().every((row) => row.status === 'revoked')).toBe(true);
  } finally {
    migrated.close();
  }
  expect((await inspectConnector(directory, one)).configured).toBe(false);
  await vi.waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      'https://relay.example.test/remote/unregister',
      expect.objectContaining({ body: JSON.stringify({ credential: old.credential }) }),
    ),
  );
});

it('never migrates files beside a live legacy connector', async () => {
  const directory = home();
  const path = join(directory, 'remote', 'config.json');
  const old = config('one');
  atomicPrivateJson(path, old);
  const server = await listenPrivate(ipcPath(directory, 'remote'), (socket) => socket.destroy());
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await expect(startConnectorManager(directory)).rejects.toThrow('already active');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(old);
});
