import { mkdtempSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROL_MAX_BYTES, PROTOCOL_VERSION, controlResponseSchema } from '@puddle/shared';
import { ipcPath, jsonLines, secret } from '@puddle/shared/node';
import { startHostControl } from '../../src/security/control.js';
import { LeaseRegistry } from '../../src/security/leases.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-control-test-'));
  let clock = 0;
  const registry = new LeaseRegistry(() => clock);
  cleanup.push(() => registry.dispose());
  const info = () => ({ port: 7434, version: { version: 'fixture', protocol: PROTOCOL_VERSION } });
  cleanup.push(await startHostControl(home, registry, info));
  const socket = connect(ipcPath(home, 'host'));
  cleanup.push(() => {
    socket.destroy();
  });
  return {
    home,
    registry,
    socket,
    info,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
function reply(socket: Socket) {
  return new Promise<ReturnType<typeof controlResponseSchema.parse>>((resolve, reject) => {
    const stop = jsonLines(
      socket,
      (value) => {
        stop();
        resolve(controlResponseSchema.parse(value));
      },
      () => reject(new Error('Invalid response')),
    );
    socket.once('error', reject);
  });
}

describe('private host control', () => {
  it('never renews an idle helper autonomously and checks late dispatch at the deadline', async () => {
    const f = await fixture();
    const received = reply(f.socket);
    f.socket.write(JSON.stringify({ t: 'open' }) + '\n');
    const grant = await received;
    expect(grant.t).toBe('authority');
    if (grant.t !== 'authority' || !grant.token) throw new Error('Missing authority');
    let closed = false;
    const resource = f.registry.attach(grant.token, secret(), () => {
      closed = true;
    });
    f.advance(45_000);
    expect(resource?.valid()).toBe(false);
    expect(closed).toBe(true);
    expect(f.registry.valid(grant.token)).toBe(false);
    const rejected = reply(f.socket);
    f.socket.write(JSON.stringify({ t: 'renew', resources: [] }) + '\n');
    expect(await rejected).toMatchObject({ t: 'error', code: 'rejected' });
  });

  it('protects a live daemon socket and rejects insecure runtime directories', async () => {
    const f = await fixture();
    const path = ipcPath(f.home, 'host');
    const inode = statSync(path).ino;
    await expect(startHostControl(f.home, f.registry, f.info)).rejects.toThrow('already active');
    expect(statSync(path).ino).toBe(inode);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Only the legacy Puddle home may migrate; IPC storage stays fail-closed.
    const runtimeDir = dirname(path);
    chmodSync(runtimeDir, 0o755);
    expect(() => ipcPath(f.home, 'host')).toThrow('must be private');
    chmodSync(runtimeDir, 0o700);
  });

  it('bounds unterminated control frames and does not accept data credentials as control messages', async () => {
    const f = await fixture();
    const closed = new Promise<void>((resolve) => f.socket.once('close', () => resolve()));
    f.socket.on('error', () => {});
    f.socket.resume();
    f.socket.write('x'.repeat(CONTROL_MAX_BYTES + 1));
    await closed;
    const second = connect(ipcPath(f.home, 'host'));
    cleanup.push(() => {
      second.destroy();
    });
    second.on('error', () => {});
    second.resume();
    const rejected = new Promise<void>((resolve) => second.once('close', () => resolve()));
    second.write(JSON.stringify({ t: 'open', token: secret('cn_') }) + '\n');
    await rejected;
  });
});

it('binds the requested profile to all resources across token rotation', async () => {
  const f = await fixture();
  const received = reply(f.socket);
  f.socket.write(JSON.stringify({ t: 'open', profile: '0123456789' }) + '\n');
  const grant = await received;
  if (grant.t !== 'authority' || !grant.token) throw new Error('Missing authority');
  expect(f.registry.attach(grant.token, secret(), () => {})?.profile).toBe('0123456789');
  f.advance(30_000);
  const renewed = reply(f.socket);
  f.socket.write(JSON.stringify({ t: 'renew', resources: [] }) + '\n');
  const replacement = await renewed;
  if (replacement.t !== 'authority' || !replacement.token) throw new Error('Missing token');
  expect(f.registry.attach(replacement.token, secret(), () => {})?.profile).toBe('0123456789');
});
