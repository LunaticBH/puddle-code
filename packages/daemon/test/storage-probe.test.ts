import { statfs } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectStorage } from '../src/storage/monitor.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  statfs: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const stats = (bytes: number, inodes: number, files = 100_000) => ({
  type: 0,
  bsize: 1,
  blocks: bytes,
  bfree: bytes,
  bavail: bytes,
  files,
  ffree: inodes,
});
describe('available space and inode thresholds', () => {
  it.each([
    [2 * 1024 ** 3, 100_000, 'ok'],
    [512 * 1024 ** 2, 100_000, 'warning'],
    [128 * 1024 ** 2, 100_000, 'critical'],
    [2 * 1024 ** 3, 5000, 'warning'],
    [2 * 1024 ** 3, 500, 'critical'],
  ] as const)('classifies %i bytes and %i inodes as %s', async (bytes, inodes, level) => {
    vi.mocked(statfs).mockResolvedValue(stats(bytes, inodes));
    expect((await inspectStorage('/volume')).level).toBe(level);
  });
  it('does not mistake an unsupported inode count for exhaustion', async () => {
    vi.mocked(statfs).mockResolvedValue(stats(2 * 1024 ** 3, 0, 0));
    expect(await inspectStorage('/volume')).toMatchObject({ level: 'ok', available_inodes: null });
  });
  it('uses the parent filesystem for a directory that has not been created yet', async () => {
    vi.mocked(statfs).mockRejectedValueOnce(Object.assign(new Error('absent'), { code: 'ENOENT' }));
    vi.mocked(statfs).mockResolvedValueOnce(stats(0, 0));
    expect(await inspectStorage('/volume/new')).toMatchObject({
      path: '/volume/new',
      level: 'critical',
    });
    expect(statfs).toHaveBeenLastCalledWith('/volume');
  });
  it('reports inspection failure instead of healthy capacity', async () => {
    vi.mocked(statfs).mockRejectedValueOnce(
      Object.assign(new Error('unavailable'), { code: 'EIO' }),
    );
    expect(await inspectStorage('/volume')).toMatchObject({
      level: 'unknown',
      available_bytes: null,
    });
  });
});
