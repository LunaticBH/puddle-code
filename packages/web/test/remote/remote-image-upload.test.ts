import { describe, expect, it, vi } from 'vitest';
import { IMAGE_UPLOAD_POLICY, REMOTE_POLICY, imageUploadRequestSchema } from '@puddle/shared';
import { uploadRemoteImage } from '../../src/features/remote/image-upload';
import type { BrowserTransport } from '../../src/lib/transport/browser-transport';

const session = crypto.randomUUID();
const saved = { path: '.puddle/pastes/image.png' };
function fixture(capable = true) {
  const chunks: Buffer[] = [];
  let received = 0;
  const request = vi.fn(
    async (
      _method: string,
      path: string,
      body?: unknown,
      _signal?: AbortSignal | null,
    ): Promise<Response> => {
      if (path === '/api/version')
        return Response.json({
          version: 'test',
          protocol: { major: 21, minor: 1 },
          ...(capable ? { remote_image_uploads: true } : {}),
        });
      if (path.endsWith('/paste')) return Response.json(saved);
      const message = imageUploadRequestSchema.parse(body);
      if (message.action === 'start' || message.action === 'cancel') received = 0;
      expect(
        Buffer.byteLength(JSON.stringify({ t: 'request', id: crypto.randomUUID(), path, body })),
      ).toBeLessThan(REMOTE_POLICY.requestBytes);
      if (message.action === 'chunk') {
        expect(message.offset).toBe(received);
        const bytes = Buffer.from(message.data, 'base64');
        chunks.push(bytes);
        received += bytes.length;
      }
      return Response.json(message.action === 'finish' ? saved : { received });
    },
  );
  const transport: BrowserTransport = {
    scope: 'host',
    generation: 'original',
    request,
    input: vi.fn(),
    socket: vi.fn(),
  };
  const progress = vi.fn();
  const send = (bytes: number, signal?: AbortSignal) =>
    uploadRemoteImage(
      transport,
      session,
      new Blob([new Uint8Array(bytes).fill(0xa5)]),
      'image/png',
      () => {},
      signal,
      progress,
    );
  return { transport, request, chunks, progress, send };
}

describe('remote image upload client', () => {
  it('preserves 4 MiB through acknowledged chunks and reports received bytes', async () => {
    const f = fixture();
    expect(await f.send(IMAGE_UPLOAD_POLICY.imageBytes)).toEqual(saved);
    expect(Buffer.concat(f.chunks).equals(Buffer.alloc(IMAGE_UPLOAD_POLICY.imageBytes, 0xa5))).toBe(
      true,
    );
    expect(f.progress.mock.calls.map(([received]) => received)).toEqual(
      Array.from({ length: 65 }, (_, index) => index * IMAGE_UPLOAD_POLICY.chunkBytes),
    );
    expect(
      f.request.mock.calls.filter(
        ([, , body]) => (body as { action?: string })?.action === 'finish',
      ),
    ).toHaveLength(1);
  });

  it('waits for each acknowledgement and refuses a concurrent upload', async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    f.request.mockImplementation(async (...args) => {
      if ((args[2] as { action?: string })?.action === 'chunk') await held;
      return original(...args);
    });
    const uploading = f.send(IMAGE_UPLOAD_POLICY.chunkBytes * 2);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(3));
    await expect(f.send(1)).rejects.toThrow('already in progress');
    expect(f.chunks).toHaveLength(0);
    resume();
    await uploading;
    expect(f.chunks).toHaveLength(2);
  });

  it('cancels on the same connection without finishing or retrying', async () => {
    const f = fixture();
    const abort = new AbortController();
    f.progress.mockImplementation((received: number) => {
      if (received) abort.abort();
    });
    await expect(f.send(IMAGE_UPLOAD_POLICY.chunkBytes * 2, abort.signal)).rejects.toThrow();
    expect(f.chunks).toHaveLength(1);
    expect(f.request.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'cancel' });
    expect(f.request.mock.calls.at(-1)?.[3]).toBeUndefined();
    expect(await f.send(1)).toEqual(saved);
  });

  it('never continues or sends cleanup into a new encryption generation', async () => {
    const f = fixture();
    f.progress.mockImplementation((received: number) => {
      if (received) Object.assign(f.transport, { generation: 'reconnected' });
    });
    await expect(f.send(IMAGE_UPLOAD_POLICY.chunkBytes * 2)).rejects.toThrow('connection changed');
    expect(f.request.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'chunk', offset: 0 });
  });

  it('rejects a bad acknowledgement and discards the upload without retry', async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) =>
      (args[2] as { action?: string })?.action === 'chunk'
        ? Response.json({ received: 99 })
        : original(...args),
    );
    await expect(f.send(1)).rejects.toThrow('acknowledgement');
    expect(f.request.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'cancel' });
    expect(f.request).toHaveBeenCalledTimes(4);
  });

  it('uses only known legacy operations on older connectors', async () => {
    const f = fixture(false);
    expect(await f.send(100)).toEqual(saved);
    expect(f.request.mock.calls.at(-1)?.[1]).toBe(`/api/worktrees/${session}/paste`);
    f.request.mockClear();
    await expect(f.send(200 * 1024)).rejects.toThrow('Update the host connector');
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]?.[1]).toBe('/api/version');
  });
});
