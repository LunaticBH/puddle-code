import { afterEach, beforeEach, expect, it, vi } from 'vitest';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', storage());
});
afterEach(() => vi.unstubAllGlobals());

it('clears invitation fragments before network work and removes the old master credential', async () => {
  localStorage.setItem('puddle.token', 'retired-master');
  const invitation = 'iv_' + 'a'.repeat(64);
  const credential = 'br_' + 'b'.repeat(64);
  vi.stubGlobal('window', {
    location: {
      hash: '#invite=' + invitation,
      href: 'http://localhost:7433/#invite=' + invitation,
    },
  });
  const replace = vi.fn();
  vi.stubGlobal('history', { replaceState: replace });
  const fetcher = vi.fn(async () => {
    expect(replace).toHaveBeenCalledOnce();
    expect(localStorage.getItem('puddle.token')).toBeNull();
    return new Response(JSON.stringify({ credential }));
  });
  vi.stubGlobal('fetch', fetcher);
  const { bootstrapToken, tokenStore } = await import('../../../src/lib/transport/auth');
  await bootstrapToken();
  expect(tokenStore.get()).toBe(credential);
  expect(fetcher.mock.calls).not.toContain('retired-master');
});

it('preserves browser authorisation on upstream rejection, and clears it only for browser rejection', async () => {
  const { tokenStore } = await import('../../../src/lib/transport/auth');
  tokenStore.set('br_' + 'a'.repeat(64));
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'upstream_expired', message: 'reconnecting' } }),
          { status: 401 },
        ),
      ),
  );
  const { api } = await import('../../../src/lib/transport/api');
  await expect(api('POST', '/api/test', {})).rejects.toMatchObject({ code: 'upstream_expired' });
  expect(tokenStore.get()).not.toBeNull();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'browser_rejected', message: 'launch again' } }),
          { status: 401 },
        ),
      ),
  );
  await expect(api('GET', '/cockpit/status')).rejects.toMatchObject({ code: 'browser_rejected' });
  expect(tokenStore.get()).toBeNull();
});

it('coalesces refresh triggers and rejects old, unauthenticated, mismatched or unready status responses', async () => {
  const { RefreshController } = await import('../../../src/lib/transport/cockpit-refresh');
  const instance = crypto.randomUUID();
  const next = crypto.randomUUID();
  const refreshId = crypto.randomUUID();
  const replies = [
    new Response(JSON.stringify({ status: 'refreshing', instance, refreshId }), { status: 202 }),
    new Response(JSON.stringify({ instance, refreshId, upstream: 'ready' })),
    new Response('{}', { status: 401 }),
    new Response(
      JSON.stringify({ instance: next, refreshId: crypto.randomUUID(), upstream: 'ready' }),
    ),
    new Response(JSON.stringify({ instance: next, refreshId, upstream: 'upstream_unavailable' })),
    new Response(JSON.stringify({ instance: next, refreshId, upstream: 'ready' })),
  ];
  const fetcher = vi.fn(async () => replies.shift()!);
  const reload = vi.fn();
  const controller = new RefreshController(fetcher, reload, async () => {});
  const first = controller.refresh();
  const second = controller.refresh();
  expect(second).toBe(first);
  expect(controller.phase).toBe('requesting');
  await expect(first).resolves.toBe(true);
  expect(reload).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(controller.phase).toBe('complete');
});
