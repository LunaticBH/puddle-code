import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REMOTE_POLICY } from '@puddle/shared';
import { DeviceStore } from '../src/devices.js';
import { Participation } from '../src/participation.js';
import { permittedRequest, permittedTerminal } from '../src/policy.js';

const peer = '12D3KooW' + 'a'.repeat(44);
describe('host device authority', () => {
  it('consumes invitations atomically, binds approval to the peer, persists revocation and enforces grant expiry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'puddle-device-'));
    let now = 1000;
    let store = new DeviceStore(directory, () => now);
    try {
      const invitation = store.invite();
      const device = store.enrol(invitation.invitation, peer, 'owner', 'Phone');
      expect(store.valid(device.id, peer, 'owner')).toBe(false);
      expect(() => store.enrol(invitation.invitation, peer, 'owner', 'Again')).toThrow();
      store.approve(device.id);
      expect(store.valid(device.id, peer, 'owner')).toBe(true);
      expect(store.valid(device.id, peer + 'x', 'owner')).toBe(false);
      expect(store.valid(device.id, peer, 'someone-else')).toBe(false);
      now += REMOTE_POLICY.idleMs;
      expect(store.valid(device.id, peer, 'owner')).toBe(false);
      store.revoke(device.id);
      store.close();
      store = new DeviceStore(directory, () => now);
      expect(store.valid(device.id, peer, 'owner')).toBe(false);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('does not accept expired, replayed or stockpiled participation', () => {
    let now = 0;
    const participation = new Participation(() => now);
    const nonce = participation.challenge()!;
    expect(participation.challenge()).toBeNull();
    now = 14_999;
    expect(participation.accept(nonce)).toBe(0);
    expect(participation.accept(nonce)).toBeNull();
    now = 45_000;
    expect(participation.valid()).toBe(false);
    expect(participation.challenge()).toBeNull();
  });
});
describe('remote surface', () => {
  const id = crypto.randomUUID();
  const request = (method: 'GET' | 'POST' | 'PATCH', path: string) =>
    permittedRequest({ t: 'request', id, method, path });
  it('denies host-wide storage diagnostics', () => {
    expect(() => request('GET', '/api/storage')).toThrow();
  });
  it('denies notebook environment discovery and installation', () => {
    for (const suffix of ['kernels', 'environments', 'status', 'kernel', 'widgets', 'widgets/comm'])
      for (const method of ['GET', 'POST'] as const)
        expect(() => request(method, `/api/notebooks/${suffix}`)).toThrow();
  });
  it('does not expose trusted puddlang execution through the remote relay', () => {
    for (const suffix of [
      'context',
      'runs',
      `runs/${id}`,
      `runs/${id}/events`,
      `runs/${id}/cancel`,
    ])
      for (const method of ['GET', 'POST'] as const)
        expect(() => request(method, `/api/puddlang/1234567890/${suffix}`)).toThrow();
  });
  it('allows text review and placement terminals', () => {
    expect(request('GET', `/api/worktrees/${id}/file?path=README.md`).path).toContain('README.md');
    expect(permittedTerminal({ t: 'stdin', session: id, term: 'agent', data: 'hello' }).t).toBe(
      'stdin',
    );
  });
  it('allows bounded directory and text reads at an explicit host root, without raw previews or writes', () => {
    const target = '00000000-0000-0000-0000-000000000000';
    for (const operation of ['tree', 'file', 'resolve', 'preview-asset']) {
      const path = `/api/worktrees/${target}/${operation}?path=notes.txt&root=%2Ftmp%2Fproject`;
      expect(request('GET', path).path).toBe(path);
      expect(() => request('POST', path)).toThrow();
      expect(() => request('GET', path + '&root=%2F')).toThrow();
    }
    for (const operation of ['media', 'download', 'upload', 'preview']) {
      expect(() =>
        request('GET', `/api/worktrees/${id}/${operation}?path=index.html&root=%2Ftmp`),
      ).toThrow();
    }
  });
  it('allows bounded image paste without opening neighbouring file-write operations', () => {
    const paste = (body: unknown, path = `/api/worktrees/${id}/paste`) =>
      permittedRequest({ t: 'request', id, method: 'POST', path, body });
    const image = { mime: 'image/png', data: 'aGVsbG8=' };
    expect(JSON.parse(paste(image).body!)).toEqual(image);
    for (const body of [
      undefined,
      { ...image, mime: 'image/svg+xml' },
      { ...image, data: '' },
      { ...image, data: 'a'.repeat(REMOTE_POLICY.requestBytes) },
      { ...image, path: '../outside.png' },
      { ...image, root: '/tmp' },
      { ...image, token: 'substitute' },
    ])
      expect(() => paste(body)).toThrow();
    for (const path of [
      `/api/worktrees/${id}/paste?root=%2Ftmp`,
      `/api/worktrees/${id}/paste?path=outside.png`,
      `/api/worktrees/${id}/upload`,
      `/api/worktrees/${id}/file`,
      '/api/worktrees/home/paste',
    ])
      expect(() => paste(image, path)).toThrow();
    expect(() => request('GET', `/api/worktrees/${id}/paste`)).toThrow();
  });
  it.each([
    '/proxy/a/3000',
    '/cockpit/refresh',
    '/agent-signal',
    '/api/config/../accounts',
    '/api/%73essions',
    '/api/sessions#fragment',
    '//evil.test/api/sessions',
    '/api/sessions?x=y',
    '/api/sessions?project=a&project=b',
    `/api/worktrees/${crypto.randomUUID()}/media?path=index.html`,
  ])('denies %s', (path) => {
    expect(() => request('GET', path)).toThrow();
  });
  it('denies writes and credential substitution', () => {
    expect(() => request('POST', `/api/worktrees/${id}/git-push`)).toThrow();
    expect(() => permittedTerminal({ t: 'auth', token: 'attacker' })).toThrow();
    expect(() =>
      permittedTerminal({ t: 'attach', session: 'home', term: 'agent', rows: 20, cols: 80 }),
    ).toThrow();
  });
});
