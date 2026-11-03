import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function storageStub(initial?: Record<string, string>): Storage {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

const KEY = 'puddle.explorerClipboard.v1';

describe('device-local explorer clipboard', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', storageStub());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('persists source identity and recovers it after a project/provider remount', async () => {
    const clipboard = await import('../../src/features/explorer/clipboard-store');
    const source = {
      sid: 'source-session',
      root: '/source',
      directory: '/source',
      host: 'host-a',
    };
    clipboard.setExplorerClipboard(['src', 'README.md'], 'copy', source);

    expect(clipboard.getExplorerClipboard()).toMatchObject({
      paths: ['src', 'README.md'],
      mode: 'copy',
      source,
    });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ source });

    vi.resetModules();
    const remounted = await import('../../src/features/explorer/clipboard-store');
    expect(remounted.getExplorerClipboard()).toMatchObject({
      paths: ['src', 'README.md'],
      source,
    });
  });

  it('retains only failed cut entries and does not clear a newer clipboard', async () => {
    const clipboard = await import('../../src/features/explorer/clipboard-store');
    clipboard.setExplorerClipboard(['one', 'two'], 'cut', {
      sid: 'source',
      directory: '/source',
      host: 'host-a',
    });
    const first = clipboard.getExplorerClipboard()!;
    clipboard.finishExplorerCut(first.id, ['two']);
    expect(clipboard.getExplorerClipboard()?.paths).toEqual(['two']);

    clipboard.setExplorerClipboard(['new'], 'copy', {
      sid: 'other',
      directory: '/other',
      host: 'host-a',
    });
    clipboard.finishExplorerCut(first.id, []);
    expect(clipboard.getExplorerClipboard()).toMatchObject({ paths: ['new'], mode: 'copy' });
  });

  it('distinguishes filetrees and requires confirmed host identity for a cross-tree transfer', async () => {
    const { confirmedSameDaemonHost, sameDaemonHost, sameFiletree } =
      await import('../../src/features/explorer/clipboard-store');
    const source = { sid: 'one', root: '/repo-a', directory: '/repo-a', host: 'host-a' };

    expect(sameFiletree(source, { ...source, sid: 'two' })).toBe(true);
    expect(
      sameFiletree(source, { sid: 'two', root: '/repo-b', directory: '/repo-b', host: 'host-a' }),
    ).toBe(false);
    expect(
      confirmedSameDaemonHost(source, { sid: 'two', directory: '/repo-b', host: 'host-a' }),
    ).toBe(true);
    expect(confirmedSameDaemonHost(source, { sid: 'two', directory: '/repo-b' })).toBe(false);
    expect(sameDaemonHost(source, { sid: 'two', directory: '/repo-b', host: 'host-b' })).toBe(
      false,
    );
  });

  it('treats one Windows directory as one filetree whatever its spelling', async () => {
    const { sameFiletree } = await import('../../src/features/explorer/clipboard-store');
    const source = { sid: 'one', directory: 'C:\\repo-a', host: 'host-a' };

    expect(sameFiletree(source, { sid: 'two', directory: 'c:/Repo-A/', host: 'host-a' })).toBe(
      true,
    );
    expect(sameFiletree(source, { sid: 'two', directory: 'C:\\repo-b', host: 'host-a' })).toBe(
      false,
    );
    // POSIX directories still compare exactly.
    expect(
      sameFiletree(
        { sid: 'one', directory: '/repo', host: 'h' },
        { sid: 'two', directory: '/Repo', host: 'h' },
      ),
    ).toBe(false);
  });

  it('ignores malformed persisted state', async () => {
    localStorage.setItem(KEY, JSON.stringify({ mode: 'cut', paths: 'not-an-array' }));
    vi.resetModules();
    const clipboard = await import('../../src/features/explorer/clipboard-store');
    expect(clipboard.getExplorerClipboard()).toBeNull();
  });
});
