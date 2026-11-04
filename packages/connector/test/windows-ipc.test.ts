import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { atomicPrivateJson, ipcPath, listenPrivate } from '@puddle/shared/node';
import { connectorPipeState } from '@puddle/shared/node/platform';
import { administrativeRequest } from '../src/admin.js';
import { startConnectorManager } from '../src/manager.js';
import { profileDirectory } from '../src/profile-state.js';

/**
 * Windows connector pipes (protocol 25.7): a pipe's name protects nothing,
 * so the connector proves it reads the home before the daemon or the CLI
 * believes it, and a server that cannot is treated as no connector at all.
 */
const profile = 'c'.repeat(10);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});

function configuredHome(enabled = false) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-connector-ipc-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  atomicPrivateJson(join(profileDirectory(home, profile), 'config.json'), {
    host: crypto.randomUUID(),
    account: 'account',
    credential: 'd'.repeat(64),
    enabled,
    service: 'https://relay.example.test',
    app: 'https://app.example.test',
  });
  return home;
}

describe.runIf(process.platform === 'win32')('Windows connector pipes', () => {
  it('prove that the connector reads the home, on its profile pipe and its lock', async () => {
    const home = configuredHome();
    const manager = await startConnectorManager(home);
    cleanups.push(() => manager.close());
    expect(await connectorPipeState(home, `remote-${profile}`)).toBe('proven');
    expect(await connectorPipeState(home, 'remote')).toBe('proven');
    // A proven exchange carries the request as before.
    expect(await administrativeRequest(home, { t: 'status' }, profile)).toMatchObject({
      enabled: false,
      connected: false,
    });
  });

  it('treat a squatter on the profile pipe as no connector', async () => {
    const home = configuredHome(true);
    const sockets = new Set<Socket>();
    let received = '';
    const squatter: Server = await listenPrivate(ipcPath(home, `remote-${profile}`), (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('data', (data: Buffer) => {
        received += data.toString();
        socket.write(JSON.stringify({ t: 'proven', proof: 'f'.repeat(64) }) + '\n');
      });
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    });
    // Status and disable fall back to the durable configuration.
    expect(await administrativeRequest(home, { t: 'status' }, profile)).toMatchObject({
      enabled: true,
      connected: false,
    });
    expect(await administrativeRequest(home, { t: 'disable' }, profile)).toEqual({
      enabled: false,
      connected: false,
    });
    // This home's runtime cannot hold a name another program serves: delete offline.
    expect(await administrativeRequest(home, { t: 'delete_registration' }, profile)).toEqual({
      enabled: false,
      connected: false,
    });
    expect(existsSync(join(profileDirectory(home, profile), 'config.json'))).toBe(false);
    // Only challenges reached it, never a request.
    for (const line of received.trim().split('\n')) {
      expect(JSON.parse(line)).toMatchObject({ t: 'challenge' });
    }
  });
});
