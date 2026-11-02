import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StorageStatus } from '@puddle/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { StorageBanner } from '../src/features/shell/StorageBanner';

const state = vi.hoisted(() => ({ minor: 5, remote: false }));
vi.mock('../src/lib/queries', () => ({
  useDaemonVersion: () => ({ data: { protocol: { major: 25, minor: state.minor } } }),
}));
vi.mock('../src/lib/browser-transport', () => ({ browserTransport: () => state.remote }));
afterEach(() => {
  state.minor = 5;
  state.remote = false;
});
const healthy: StorageStatus = {
  checked_at: '2026-11-02T00:00:00Z',
  volumes: [],
  logs_degraded: false,
  database_degraded: false,
};
function render(data: StorageStatus) {
  const client = new QueryClient();
  client.setQueryData(['storage'], data);
  try {
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(StorageBanner)),
    );
  } finally {
    client.clear();
  }
}
it('stays hidden when storage and persistence are healthy', () => {
  expect(render(healthy)).toBe('');
});
it('shows explicit persistence failures and affected paths with space and inodes', () => {
  const html = render({
    ...healthy,
    logs_degraded: true,
    database_degraded: true,
    volumes: [{ path: '/data/puddle', available_bytes: 0, available_inodes: 0, level: 'critical' }],
  });
  expect(html).toContain('Terminal history is temporarily not being saved');
  expect(html).toContain('Changes cannot be saved');
  expect(html).toContain('/data/puddle');
  expect(html).toContain('0 MiB available');
  expect(html).toContain('0 inodes available');
});
it('does not expose cached host storage on an older daemon or remote transport', () => {
  const degraded = { ...healthy, logs_degraded: true };
  state.minor = 4;
  expect(render(degraded)).toBe('');
  state.minor = 5;
  state.remote = true;
  expect(render(degraded)).toBe('');
});
