import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, REMOTE_PROTOCOL_VERSION } from '@puddle/shared';
import type { RemoteClient } from '../../src/features/remote/client';

const mocks = vi.hoisted(() => ({
  worker: vi.fn(),
  subscription: vi.fn(),
  service: vi.fn(),
  previewKey: vi.fn(),
}));
vi.mock('../../src/lib/notifications/notification-worker', () => ({
  notificationWorker: mocks.worker,
}));
vi.mock('../../src/features/remote/service', () => ({
  serviceOrigin: 'https://relay.example.test',
  serviceRequest: mocks.service,
}));
vi.mock('../../src/features/remote/notification-keys', () => ({
  notificationKey: mocks.previewKey,
  forgetNotificationKeys: vi.fn(),
}));

const account = 'notification-reader';
const key = `puddle.push:https://relay.example.test:${account}`;
const subscription = {
  toJSON: () => ({
    endpoint: 'https://web.push.apple.com/test',
    keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
  }),
};
let api: typeof import('../../src/features/remote/push-notifications');
let request: ReturnType<typeof vi.fn<RemoteClient['request']>>;
let client: RemoteClient;
let unwatch: () => void;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  const storage = new Map([[key, 'true']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal('Notification', { permission: 'granted' });
  mocks.subscription.mockReset().mockResolvedValue(subscription);
  mocks.service.mockReset().mockResolvedValue({
    providers: ['github'],
    protocol: REMOTE_PROTOCOL_VERSION,
    push_encrypted_previews: true,
  });
  mocks.previewKey
    .mockReset()
    .mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001', secret: 'c'.repeat(64) });
  mocks.worker
    .mockReset()
    .mockResolvedValue({ pushManager: { getSubscription: mocks.subscription } });
  request = vi.fn(async (_method, path) => {
    if (path === '/api/version')
      return Response.json({
        version: 'test',
        protocol: PROTOCOL_VERSION,
        remote_notifications: true,
      });
    if (path === '/api/notifications/push') return Response.json({ enabled: true });
    if (path === '/api/notifications/test')
      return Response.json({
        state: 'shown',
        message: 'The push service accepted the notification.',
      });
    throw new Error(`Unexpected request: ${path}`);
  });
  // Transport boundary only: no real host, browser identity or network connection.
  client = {
    state: 'connecting',
    generation: 'first',
    scope: 'test-host',
    host: { account },
    request,
    onState: () => () => {},
  } as unknown as RemoteClient;
  api = await import('../../src/features/remote/push-notifications');
  unwatch = api.watchPushNotifications(client);
  client.state = 'ready';
});
afterEach(() => {
  unwatch();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('reports progress and confirms registration afresh before every explicit test', async () => {
  const progress = vi.fn();
  await expect(api.testPushNotifications(account, progress)).resolves.toContain('accepted');
  expect(progress.mock.calls.map(([message]) => message)).toEqual([
    'Checking host notification support…',
    'Checking this device’s push subscription…',
    'Registering this device with the host…',
    'Sending the test through the push service…',
  ]);
  await api.testPushNotifications(account);
  expect(request.mock.calls.map(([, path]) => path)).toEqual([
    '/api/version',
    '/api/notifications/push',
    '/api/notifications/test',
    '/api/version',
    '/api/notifications/push',
    '/api/notifications/test',
  ]);
});

function previewHost() {
  const original = request.getMockImplementation()!;
  request.mockImplementation((...args) =>
    args[1] === '/api/version'
      ? Promise.resolve(
          Response.json({
            version: 'test',
            protocol: PROTOCOL_VERSION,
            remote_notifications: true,
            remote_notification_previews: true,
          }),
        )
      : original(...args),
  );
}

it('registers preview keys only with a capable connector and service', async () => {
  await api.testPushNotifications(account);
  expect(mocks.previewKey).not.toHaveBeenCalled();
  previewHost();
  await api.testPushNotifications(account);
  expect(request).toHaveBeenCalledWith('POST', '/api/notifications/push', {
    subscription: subscription.toJSON(),
    preview_key: { id: '00000000-0000-4000-8000-000000000001', secret: 'c'.repeat(64) },
  });
  mocks.previewKey.mockClear();
  mocks.service.mockResolvedValue({ providers: ['github'], protocol: REMOTE_PROTOCOL_VERSION });
  await api.testPushNotifications(account);
  expect(mocks.previewKey).not.toHaveBeenCalled();
});

it('does not restore a subscription after opt-out during preview discovery', async () => {
  previewHost();
  mocks.service.mockImplementationOnce(async () => {
    localStorage.setItem(key, 'false');
    return {
      providers: ['github'],
      protocol: REMOTE_PROTOCOL_VERSION,
      push_encrypted_previews: true,
    };
  });
  await expect(api.testPushNotifications(account)).rejects.toThrow();
  expect(mocks.previewKey).not.toHaveBeenCalled();
  expect(request.mock.calls.map(([, path]) => path)).toEqual(['/api/version']);
});

it('bounds service preview discovery and ignores a late response', async () => {
  previewHost();
  let finish!: (value: unknown) => void;
  mocks.service.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = expect(api.testPushNotifications(account)).rejects.toThrow(
    'checking notification previews',
  );
  await vi.advanceTimersByTimeAsync(10_000);
  await pending;
  finish({
    providers: ['github'],
    protocol: REMOTE_PROTOCOL_VERSION,
    push_encrypted_previews: true,
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.previewKey).not.toHaveBeenCalled();
  expect(request.mock.calls.map(([, path]) => path)).toEqual(['/api/version']);
});

it('times out a stalled subscription read without sending after a late reply', async () => {
  let finish!: (value: typeof subscription) => void;
  mocks.subscription.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = api.testPushNotifications(account);
  const rejected = expect(pending).rejects.toThrow('checking its push subscription');
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  finish(subscription);
  await vi.advanceTimersByTimeAsync(1);
  expect(request.mock.calls.map(([, path]) => path)).toEqual(['/api/version']);
  await expect(api.testPushNotifications(account)).resolves.toContain('accepted');
});

it('distinguishes a missing subscription from an OS permission grant', async () => {
  mocks.subscription.mockResolvedValueOnce(null);
  await expect(api.testPushNotifications(account)).rejects.toThrow('no active push subscription');
  expect(request.mock.calls.map(([, path]) => path)).toEqual(['/api/version']);
});

it('does not send a test through a different connection generation', async () => {
  mocks.subscription.mockImplementationOnce(async () => {
    Object.assign(client, { generation: 'second' });
    return subscription;
  });
  await expect(api.testPushNotifications(account)).rejects.toThrow('connection changed');
  expect(request.mock.calls.map(([, path]) => path)).toEqual(['/api/version']);
});

it('keeps a host rejection visible without proceeding to send', async () => {
  request.mockImplementation(async (_method, path) =>
    path === '/api/version'
      ? Response.json({ version: 'test', protocol: PROTOCOL_VERSION, remote_notifications: true })
      : Response.json({}, { status: 503 }),
  );
  await expect(api.testPushNotifications(account)).rejects.toThrow('Could not enable');
  expect(request.mock.calls.some(([, path]) => path === '/api/notifications/test')).toBe(false);
});

it('returns the vendor failure instead of treating a completed request as delivery', async () => {
  const original = request.getMockImplementation()!;
  request.mockImplementation((...args) =>
    args[1] === '/api/notifications/test'
      ? Promise.resolve(Response.json({ state: 'failed', message: 'Push delivery failed.' }))
      : original(...args),
  );
  await expect(api.testPushNotifications(account)).resolves.toBe('Push delivery failed.');
});
