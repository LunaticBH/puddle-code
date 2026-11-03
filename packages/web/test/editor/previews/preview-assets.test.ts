import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installBrowserTransport,
  type BrowserTransport,
} from '../../../src/lib/transport/browser-transport';
import { api } from '../../../src/lib/transport/api';
import { fetchPreviewAsset } from '../../../src/features/editor/previews/preview-assets';

vi.mock('../../../src/lib/transport/api', () => ({ api: vi.fn(), apiFetchRaw: vi.fn() }));

function transport(scope: string): BrowserTransport {
  return {
    scope,
    request: async () => new Response(),
    input: async () => {},
    socket: () => {
      throw new Error('No socket in asset tests');
    },
  };
}

afterEach(() => {
  installBrowserTransport(null);
  vi.resetAllMocks();
});

describe('remote preview asset reads', () => {
  it('bounds concurrent reads and preserves binary bytes and the browse root', async () => {
    installBrowserTransport(transport('first'));
    const finish: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    vi.mocked(api).mockImplementation(async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise<void>((resolve) => finish.push(resolve));
      active -= 1;
      return { mime: 'image/png', data: 'AP+A' };
    });
    const reads = Array.from({ length: 12 }, () =>
      fetchPreviewAsset('session', 'a b.png', '/outside'),
    );
    for (let i = 0; i < 6; i++) {
      await vi.waitFor(() => expect(finish).toHaveLength(2));
      finish.splice(0).forEach((resolve) => resolve());
    }
    const blobs = await Promise.all(reads);
    expect(maximum).toBe(2);
    expect(api).toHaveBeenCalledWith(
      'GET',
      '/api/worktrees/session/preview-asset?path=a%20b.png&root=%2Foutside',
    );
    expect(blobs[0]!.type).toBe('image/png');
    expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]));
  });

  it('rejects queued reads after a host switch without dispatching them to the new host', async () => {
    installBrowserTransport(transport('first'));
    const finish: Array<() => void> = [];
    vi.mocked(api).mockImplementation(
      () => new Promise((resolve) => finish.push(() => resolve({ mime: 'image/png', data: '' }))),
    );
    const reads = [fetchPreviewAsset('session', 'a'), fetchPreviewAsset('session', 'b')];
    const queued = fetchPreviewAsset('session', 'c');
    const rejected = expect(queued).rejects.toThrow('Preview host changed');
    installBrowserTransport(transport('second'));
    finish.forEach((resolve) => resolve());
    await Promise.all(reads);
    await rejected;
    expect(api).toHaveBeenCalledTimes(2);
  });
});
