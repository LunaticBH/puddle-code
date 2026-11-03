import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startUiServer, type UiServer } from '../../src/lib/serve/ui-server.js';

const opened: { ui: UiServer; home: string }[] = [];
afterEach(async () => {
  for (const { ui, home } of opened.splice(0)) {
    await ui.close();
    await rm(home, { recursive: true, force: true });
  }
});

async function cockpit(identity: string, reveal = vi.fn(async () => {})) {
  const home = await mkdtemp(join(tmpdir(), 'puddle-reveal-'));
  await writeFile(join(home, 'index.html'), '<!doctype html>');
  const ui = await startUiServer({
    assetsDir: home,
    authHome: home,
    identity,
    port: 0,
    target: { host: '127.0.0.1', port: 1 },
    authority: {
      state: 'ready',
      credential: () => '',
      onChange: () => () => {},
      close() {},
      generation: null,
      resource() {
        throw new Error('No daemon calls in this fixture');
      },
    },
    fileManager: { name: 'Finder', reveal },
  });
  opened.push({ ui, home });
  const invitation = new URLSearchParams(new URL(ui.createInvitation()).hash.slice(1)).get(
    'invite',
  );
  const response = await fetch(ui.origin + '/cockpit/bootstrap', {
    method: 'POST',
    headers: { origin: ui.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ invitation }),
  });
  const { credential } = (await response.json()) as { credential: string };
  const request = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(ui.origin + '/cockpit/file-manager', {
      method,
      headers: {
        origin: ui.origin,
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ui, credential, request, reveal };
}

describe('local file-manager gateway', () => {
  it('requires browser authority, exact origin, and a bounded path before native dispatch', async () => {
    const { request, reveal } = await cockpit('local');
    expect(await (await request('GET')).json()).toEqual({ name: 'Finder' });
    expect((await request('GET', undefined, { authorization: '' })).status).toBe(401);
    const path = '/work/project/file.txt';
    expect(
      (await request('POST', { path }, { origin: 'https://foreign.example.test' })).status,
    ).toBe(403);
    expect((await request('POST', { path }, { origin: '' })).status).toBe(403);
    expect((await request('POST', { path }, { authorization: '' })).status).toBe(401);
    for (const body of [
      { path: '' },
      { path: 'x'.repeat(4097) },
      { path: '/work/\0file' },
      { path, command: 'open' },
    ])
      expect((await request('POST', body)).status).toBe(400);
    expect(reveal).not.toHaveBeenCalled();
    expect((await request('POST', { path })).status).toBe(204);
    expect(reveal).toHaveBeenCalledExactlyOnceWith(path, expect.any(Function));
    expect((await request('DELETE')).status).toBe(405);
  });

  it('refuses SSH-host paths even when the cockpit is served on localhost and a manager was supplied', async () => {
    const { request, reveal } = await cockpit('developer@build-host');
    expect(await (await request('GET')).json()).toEqual({ name: null });
    expect((await request('POST', { path: '/work/file.txt' })).status).toBe(404);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('bounds concurrent OS launches and surfaces failures', async () => {
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reveal = vi.fn(async () => {
      finish();
      await pending;
      throw new Error('File is missing');
    });
    const { request } = await cockpit('local', reveal);
    const first = request('POST', { path: '/work/file.txt' });
    await started;
    const busy = await request('POST', { path: '/work/other.txt' });
    release();
    expect(busy.status).toBe(409);
    expect(await (await first).json()).toEqual({
      error: { code: 'reveal_failed', message: 'File is missing' },
    });
    expect(reveal).toHaveBeenCalledOnce();
  });
});
