import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopNotificationRequest } from '@puddle/shared';
const mocks = vi.hoisted(() => ({
  worker: vi.fn(),
  show: vi.fn(async () => {}),
  bridge: vi.fn<() => ReturnType<typeof import('../../../src/lib/desktop').desktopBridge>>(),
}));
vi.mock('../../../src/lib/desktop', () => ({ desktopBridge: mocks.bridge }));
vi.mock('../../../src/lib/notifications/notification-worker', () => ({
  notificationWorker: mocks.worker,
  showWorkerNotification: mocks.show,
}));
import { deliverNotification } from '../../../src/lib/notifications/notification-delivery';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.bridge.mockReset();
});
const request = { id: 'test', title: 'Agent', body: 'Finished' };
const context = { host: 'Build host', project: { name: 'Example project', abbrev: 'EX' } };

describe('desktop notification headings', () => {
  it.each([true, false])(
    'uses a subtitle only when the shell advertises support: %s',
    async (supported) => {
      const show = vi.fn(async (_request: DesktopNotificationRequest) => ({
        state: 'shown' as const,
        message: null,
      }));
      mocks.bridge.mockReturnValue({
        raiseWindow() {},
        showNotification: show,
        notificationSubtitles: supported,
      });
      await deliverNotification(request, () => {}, context);
      expect(show).toHaveBeenCalledExactlyOnceWith(
        supported
          ? { ...request, title: 'Build host · Example project', subtitle: 'Agent' }
          : request,
      );
    },
  );
});

describe('browser notification delivery', () => {
  it('uses persistent service-worker notifications where the mobile constructor throws', async () => {
    const constructor = vi.fn(() => {
      throw new TypeError('Illegal constructor');
    });
    vi.stubGlobal('Notification', Object.assign(constructor, { permission: 'granted' }));
    const showNotification = vi.fn(async () => {});
    const subscribe = vi.fn();
    vi.stubGlobal('navigator', { serviceWorker: { addEventListener: subscribe } });
    mocks.worker.mockResolvedValue({ showNotification });
    const click = vi.fn();
    const target = { project: '0123456789', session: '20000000-0000-4000-8000-000000000001' };
    await expect(deliverNotification({ ...request, target }, click, context)).resolves.toEqual({
      state: 'shown',
      message: null,
    });
    expect(constructor).not.toHaveBeenCalled();
    expect(mocks.show).toHaveBeenCalledExactlyOnceWith(
      { showNotification },
      { ...request, title: '[EX] Agent', target },
    );
    subscribe.mock.calls[0]![1]({ data: { t: 'notification-click', id: 'test' } });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      context: { ...context, project: { name: 'Example project', abbrev: null } },
      title: '[EXAMP] Agent',
    },
    { context: undefined, title: 'Agent' },
  ])(
    'formats constructor titles and leaves context-free tests alone: $title',
    async ({ context, title }) => {
      mocks.worker.mockResolvedValue(null);
      const notification = {
        onshow: null as (() => void) | null,
        onclick: null as (() => void) | null,
        close: vi.fn(),
      };
      const constructor = vi.fn(function () {
        queueMicrotask(() => notification.onshow?.());
        return notification;
      });
      vi.stubGlobal('Notification', Object.assign(constructor, { permission: 'granted' }));
      vi.stubGlobal('window', { focus: vi.fn() });
      const click = vi.fn();
      await expect(deliverNotification(request, click, context)).resolves.toEqual({
        state: 'shown',
        message: null,
      });
      expect(constructor).toHaveBeenCalledExactlyOnceWith(title, {
        body: 'Finished',
        tag: 'test',
        silent: true,
      });
      notification.onclick?.();
      expect(click).toHaveBeenCalledOnce();
      expect(notification.close).toHaveBeenCalledOnce();
    },
  );

  it('surfaces rejected permission and service-worker delivery errors', async () => {
    vi.stubGlobal('Notification', { permission: 'denied' });
    expect((await deliverNotification(request, () => {})).state).toBe('failed');
    expect(mocks.worker).not.toHaveBeenCalled();
    vi.stubGlobal('Notification', { permission: 'granted' });
    mocks.worker.mockResolvedValue({});
    mocks.show.mockRejectedValueOnce(new Error('System denied delivery'));
    await expect(deliverNotification(request, () => {})).resolves.toEqual({
      state: 'failed',
      message: 'System denied delivery',
    });
  });

  it('catches browser constructor failures when no service worker is available', async () => {
    mocks.worker.mockResolvedValue(null);
    vi.stubGlobal(
      'Notification',
      Object.assign(
        function () {
          throw new Error('Unsupported');
        },
        { permission: 'granted' },
      ),
    );
    await expect(deliverNotification(request, () => {})).resolves.toEqual({
      state: 'failed',
      message: 'Unsupported',
    });
  });
});
