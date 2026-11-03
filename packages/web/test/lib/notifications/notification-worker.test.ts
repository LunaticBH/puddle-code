import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID, webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { encryptNotification } from '../../../../connector/src/notification-preview.js';
import {
  notificationKey,
  forgetNotificationKeys,
} from '../../../src/features/remote/notification-keys';

const source = readFileSync(
  new URL('../../../public/notification-worker.js', import.meta.url),
  'utf8',
);
function worker(indexedDB = new IDBFactory()) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => {});
  const client = {
    id: 'app-window',
    frameType: 'top-level',
    url: 'https://app.example.test/',
    focus: vi.fn(async () => {}),
    postMessage: vi.fn(),
  };
  const windows = [client];
  runInNewContext(source, {
    indexedDB,
    URL,
    Date,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    self: {
      location: { origin: 'https://app.example.test' },
      registration: { showNotification },
      clients: { matchAll: async () => windows, openWindow, claim: async () => {} },
      addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) =>
        handlers.set(name, handler),
    },
  });
  const emit = async (name: string, event: Record<string, unknown>) => {
    let pending = Promise.resolve();
    handlers.get(name)!({
      ...event,
      waitUntil: (task: Promise<void>) => {
        pending = task;
      },
    });
    await pending;
  };
  const push = (id: string, host = randomUUID()) =>
    emit('push', { data: { json: () => ({ id, host }) } });
  const live = (id: string) =>
    emit('message', {
      data: {
        t: 'show-notification',
        request: { id: `puddle-event-${id}`, title: 'Agent', body: 'Finished' },
      },
      source: client,
      ports: [{ postMessage: vi.fn() }],
    });
  return { emit, push, live, showNotification, indexedDB, client, windows, openWindow };
}

describe('notification worker', () => {
  it('decrypts host previews after restart, authenticates the destination, and opens that session', async () => {
    const f = worker();
    vi.stubGlobal('indexedDB', f.indexedDB);
    try {
      const host = randomUUID();
      const id = randomUUID();
      const key = await notificationKey('https://service.example.test', 'account', host);
      expect(await notificationKey('https://service.example.test', 'account', host)).toEqual(key);
      const content = {
        title: '[PROJ] Fix the mobile settings',
        body: 'Fixed the overflow and verified narrow screens.',
        project: '0123456789',
        session: randomUUID(),
      };
      const preview = encryptNotification(content, key, host, id);
      const restarted = worker(f.indexedDB);
      await restarted.emit('push', { data: { json: () => ({ id, host, preview }) } });
      const target = { project: content.project, session: content.session, host };
      expect(restarted.showNotification).toHaveBeenCalledWith(
        content.title,
        expect.objectContaining({ body: content.body, data: { host, target } }),
      );
      const notification = { tag: `puddle-event-${id}`, data: { host, target }, close: vi.fn() };
      await restarted.emit('notificationclick', { notification });
      expect(restarted.client.postMessage).toHaveBeenCalledWith({
        t: 'notification-click',
        id: notification.tag,
        host,
        target,
      });
      restarted.windows.length = 0;
      await restarted.emit('notificationclick', { notification });
      expect(restarted.openWindow).toHaveBeenCalledWith(
        `/?notificationHost=${host}&notificationProject=${content.project}&notificationSession=${content.session}`,
      );
      // Swapping event/host identifiers invalidates authentication; still show a visible fallback.
      await restarted.emit('push', { data: { json: () => ({ id: randomUUID(), host, preview }) } });
      expect(restarted.showNotification).toHaveBeenLastCalledWith(
        'Puddle',
        expect.objectContaining({ body: 'An agent needs your attention.', data: { host } }),
      );
      await forgetNotificationKeys('https://service.example.test', 'account', host);
      await restarted.emit('push', { data: { json: () => ({ id, host, preview }) } });
      expect(restarted.showNotification).toHaveBeenLastCalledWith(
        'Puddle',
        expect.objectContaining({ data: { host } }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens the exact local session after the originating browser tab has closed', async () => {
    const f = worker();
    const target = { project: '0123456789', session: randomUUID() };
    await f.emit('message', {
      data: {
        t: 'show-notification',
        request: { id: 'local', title: 'Conversation', body: 'Done', target },
      },
      source: f.client,
      ports: [],
    });
    expect(f.showNotification).toHaveBeenCalledWith(
      'Conversation',
      expect.objectContaining({ data: { client: f.client.id, target } }),
    );
    f.windows.length = 0;
    await f.emit('notificationclick', {
      notification: { tag: 'local', data: { target }, close: vi.fn() },
    });
    expect(f.openWindow).toHaveBeenCalledWith(
      `/project/${target.project}/session/${target.session}`,
    );
  });

  it('suppresses duplicated live events but fulfils the visible-notification promise for every push', async () => {
    const f = worker();
    const id = randomUUID();
    await Promise.all([f.push(id), f.live(id), f.live(id)]);
    expect(f.showNotification).toHaveBeenCalledTimes(1);
    const restarted = worker(f.indexedDB);
    await restarted.live(id);
    expect(restarted.showNotification).not.toHaveBeenCalled();
    await restarted.push(id);
    expect(restarted.showNotification).toHaveBeenCalledTimes(1);
  });

  it('does not suppress a retry after failed notification delivery', async () => {
    const f = worker();
    const id = randomUUID();
    f.showNotification.mockRejectedValueOnce(new Error('Permission denied'));
    await expect(f.push(id)).rejects.toThrow('Permission denied');
    await f.push(id);
    expect(f.showNotification).toHaveBeenCalledTimes(2);
  });

  it('rejects untrusted message sources and invalid push payloads', async () => {
    const f = worker();
    await f.emit('message', {
      data: { t: 'show-notification', request: { id: 'test', title: 'Agent', body: 'Finished' } },
      source: { url: 'https://other.example.test/' },
      ports: [],
    });
    await f.emit('push', { data: { json: () => ({ id: 'invalid', host: 'invalid' }) } });
    expect(f.showNotification).not.toHaveBeenCalled();
  });

  it('focuses an existing app on click, or opens only the host identifier on a cold start', async () => {
    const f = worker();
    const host = randomUUID();
    const notification = { tag: 'puddle-event-test', data: { host }, close: vi.fn() };
    await f.emit('notificationclick', { notification });
    expect(f.client.focus).toHaveBeenCalledTimes(1);
    expect(f.client.postMessage).toHaveBeenCalledWith({
      t: 'notification-click',
      id: notification.tag,
      host,
    });
    f.windows.length = 0;
    await f.emit('notificationclick', { notification });
    expect(f.openWindow).toHaveBeenCalledWith(`/?notificationHost=${host}`);
  });
});
