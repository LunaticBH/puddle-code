import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../src/lib/transport/api';
import {
  installBrowserTransport,
  type BrowserTransport,
} from '../../../src/lib/transport/browser-transport';
import { wsManager } from '../../../src/lib/transport/ws';
import { pasteImage } from '../../../src/features/terminal/clipboard/paste-image';
import { prepareImage } from '../../../src/features/terminal/clipboard/prepare-image';

vi.mock('../../../src/lib/transport/api', () => ({ api: vi.fn() }));
vi.mock('../../../src/lib/transport/ws', () => ({
  wsManager: { isConnected: vi.fn(() => true), write: vi.fn() },
}));

const file = new File(['image'], 'image.png', { type: 'image/png' });
const session = '00000000-0000-4000-8000-000000000001';
const path = '.puddle/pastes/image.png';
const remote = (): BrowserTransport => ({
  scope: crypto.randomUUID(),
  generation: crypto.randomUUID(),
  request: vi.fn(async (method, url, body) =>
    Response.json(
      url === '/api/version'
        ? { version: 'test', protocol: { major: 21, minor: 1 } }
        : await api(method, url, body),
    ),
  ),
  input: vi.fn().mockResolvedValue(undefined),
  socket: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api).mockResolvedValue({ path });
  vi.mocked(wsManager.isConnected).mockReturnValue(true);
  vi.stubGlobal(
    'FileReader',
    class {
      result = 'data:image/png;base64,aW1hZ2U=';
      onload?: () => void;
      readAsDataURL() {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
});
afterEach(() => {
  installBrowserTransport(null);
  vi.unstubAllGlobals();
});

describe('shared image paste', () => {
  it('inserts the uploaded path on desktop without submitting', async () => {
    await pasteImage(file, session, 'agent');
    expect(api).toHaveBeenCalledWith('POST', `/api/worktrees/${session}/paste`, {
      mime: 'image/png',
      data: 'aW1hZ2U=',
    });
    expect(wsManager.write).toHaveBeenCalledExactlyOnceWith(session, 'agent', `${path} `);
  });
  it('uses acknowledged remote input without submitting or applying keyboard modifiers', async () => {
    const transport = remote();
    installBrowserTransport(transport);
    await pasteImage(file, session, 'agent');
    expect(transport.input).toHaveBeenCalledExactlyOnceWith(session, 'agent', `${path} `);
    expect(wsManager.write).not.toHaveBeenCalled();
  });
  it('does not insert an uploaded path into a different host after a switch', async () => {
    const original = remote();
    const replacement = remote();
    installBrowserTransport(original);
    vi.mocked(api).mockImplementationOnce(async () => {
      installBrowserTransport(replacement);
      return { path };
    });
    await expect(pasteImage(file, session, 'agent')).rejects.toThrow('connection changed');
    expect(original.input).not.toHaveBeenCalled();
    expect(replacement.input).not.toHaveBeenCalled();
    expect(wsManager.write).not.toHaveBeenCalled();
  });
  it('never inserts or retries a failed upload', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('Connection interrupted'));
    await expect(pasteImage(file, session, 'agent')).rejects.toThrow('Connection interrupted');
    expect(api).toHaveBeenCalledTimes(1);
    expect(wsManager.write).not.toHaveBeenCalled();
  });
  it('rejects unsupported and oversized input before upload or image decoding', async () => {
    await expect(
      prepareImage(new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' }), true),
    ).rejects.toThrow('PNG, JPEG, GIF or WebP');
    await expect(
      prepareImage(new File([], 'empty.png', { type: 'image/png' }), true),
    ).rejects.toThrow('empty');
    await expect(
      prepareImage(
        new File([new Uint8Array(21 * 1024 * 1024)], 'large.png', { type: 'image/png' }),
        true,
      ),
    ).rejects.toThrow('20 MiB');
    await expect(
      prepareImage(
        new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'animation.gif', { type: 'image/gif' }),
        true,
      ),
    ).rejects.toThrow('no larger than 4 MiB');
    expect(api).not.toHaveBeenCalled();
  });

  it('does not insert after cancellation or reconnect on the same transport object', async () => {
    for (const action of ['cancel', 'reconnect']) {
      const transport = remote();
      installBrowserTransport(transport);
      const abort = new AbortController();
      vi.mocked(api).mockImplementationOnce(async () => {
        if (action === 'cancel') abort.abort();
        else Object.assign(transport, { generation: crypto.randomUUID() });
        return { path };
      });
      await expect(pasteImage(file, session, 'agent', { signal: abort.signal })).rejects.toThrow();
      expect(transport.input).not.toHaveBeenCalled();
    }
  });

  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])(
    'preserves images up to 4 MiB: %s',
    async (type) => {
      const original = new File([new Uint8Array(4 * 1024 * 1024)], 'image', { type });
      const decode = vi.fn();
      vi.stubGlobal('createImageBitmap', decode);
      expect(await prepareImage(original, true)).toEqual({
        blob: original,
        mime: type,
        resized: false,
      });
      expect(decode).not.toHaveBeenCalled();
    },
  );
});
