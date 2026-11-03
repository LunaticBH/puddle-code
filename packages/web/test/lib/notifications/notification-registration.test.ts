import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const registration = { active: { state: 'activated' } };
let register: ReturnType<typeof vi.fn>;
let worker: typeof import('../../../src/lib/notifications/notification-worker');
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  register = vi.fn().mockResolvedValue(registration);
  vi.stubGlobal('navigator', { serviceWorker: { register } });
  vi.stubGlobal('window', { isSecureContext: true });
  worker = await import('../../../src/lib/notifications/notification-worker');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('shares a successful registration across concurrent and subsequent notification operations', async () => {
  expect(await Promise.all([worker.notificationWorker(), worker.notificationWorker()])).toEqual([
    registration,
    registration,
  ]);
  await worker.notificationWorker();
  expect(register).toHaveBeenCalledExactlyOnceWith('/notification-worker.js');
});

it('bounds registration stalls and retries without accepting a late result into the cache', async () => {
  let finish!: (value: unknown) => void;
  register.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = worker.notificationWorker();
  const rejected = expect(pending).rejects.toThrow('Notification support did not respond');
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  expect(await worker.notificationWorker()).toBe(registration);
  finish({ active: { state: 'redundant' } });
  await vi.advanceTimersByTimeAsync(1);
  expect(await worker.notificationWorker()).toBe(registration);
  expect(register).toHaveBeenCalledTimes(2);
});

it('clears a failed activation so the next attempt can register again', async () => {
  register.mockResolvedValueOnce({ active: null, installing: null, waiting: null });
  await expect(worker.notificationWorker()).rejects.toThrow('could not start');
  expect(await worker.notificationWorker()).toBe(registration);
  expect(register).toHaveBeenCalledTimes(2);
});
