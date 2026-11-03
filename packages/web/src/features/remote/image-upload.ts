import {
  IMAGE_UPLOAD_POLICY,
  REMOTE_POLICY,
  errorResponseSchema,
  imageUploadProgressSchema,
  pasteImageResponseSchema,
  versionResponseSchema,
  type ImageUploadRequest,
  type PasteImageMime,
  type PasteImageResponse,
} from '@puddle/shared';
import type { BrowserTransport } from '../../lib/transport/browser-transport';

const active = new WeakSet<BrowserTransport>();
const LEGACY_IMAGE_BYTES = Math.floor(((REMOTE_POLICY.requestBytes - 1024) * 3) / 4);

/** Acknowledged chunks share the existing encrypted connection with terminal traffic. */
export async function uploadRemoteImage(
  transport: BrowserTransport,
  session: string,
  blob: Blob,
  mime: PasteImageMime,
  checkConnection: () => void,
  signal?: AbortSignal,
  progress?: (received: number, total: number) => void,
): Promise<PasteImageResponse> {
  const generation = transport.generation;
  const check = () => {
    signal?.throwIfAborted();
    checkConnection();
    if (transport.generation !== generation)
      throw new Error('The connection changed; the image upload was interrupted.');
  };
  check();
  if (!blob.size || blob.size > IMAGE_UPLOAD_POLICY.imageBytes)
    throw new Error('The prepared image must be no larger than 4 MiB.');
  if (active.has(transport)) throw new Error('An image upload is already in progress.');
  active.add(transport);
  const upload = crypto.randomUUID();
  const path = `/api/worktrees/${session}/paste-upload`;
  let started = false;
  let completed = false;
  const request = async (method: string, url: string, body?: unknown): Promise<unknown> => {
    check();
    const response = await transport.request(method, url, body, signal);
    const value: unknown = await response.json();
    check();
    if (!response.ok) {
      const error = errorResponseSchema.safeParse(value);
      throw new Error(error.success ? error.data.error.message : 'The image upload failed.');
    }
    return value;
  };
  const send = (body: ImageUploadRequest) => request('POST', path, body);
  const base64 = async (part: Blob) => {
    const bytes = new Uint8Array(await part.arrayBuffer());
    check();
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
  };
  try {
    // Unknown routes close older connectors: detect support through a known operation first.
    const version = versionResponseSchema.parse(await request('GET', '/api/version'));
    progress?.(0, blob.size);
    if (!version.remote_image_uploads) {
      if (blob.size > LEGACY_IMAGE_BYTES)
        throw new Error('Update the host connector to upload images larger than 191 KiB.');
      const data = await base64(blob);
      const result = pasteImageResponseSchema.parse(
        await request('POST', `/api/worktrees/${session}/paste`, { mime, data }),
      );
      progress?.(blob.size, blob.size);
      return result;
    }
    started = true;
    const first = imageUploadProgressSchema.parse(
      await send({ action: 'start', upload, mime, size: blob.size }),
    );
    if (first.received !== 0) throw new Error('Invalid image upload acknowledgement.');
    for (let offset = 0; offset < blob.size; offset += IMAGE_UPLOAD_POLICY.chunkBytes) {
      const part = blob.slice(offset, offset + IMAGE_UPLOAD_POLICY.chunkBytes);
      const data = await base64(part);
      const ack = imageUploadProgressSchema.parse(
        await send({ action: 'chunk', upload, offset, data }),
      );
      if (ack.received !== offset + part.size)
        throw new Error('Invalid image upload acknowledgement.');
      progress?.(ack.received, blob.size);
    }
    const result = pasteImageResponseSchema.parse(await send({ action: 'finish', upload }));
    completed = true;
    return result;
  } finally {
    if (started && !completed && transport.generation === generation) {
      try {
        checkConnection();
        // Cancel on the original connection even when the caller's signal is aborted.
        // Do not await an uncertain network acknowledgement or retry after reconnect.
        void transport.request('POST', path, { action: 'cancel', upload }).catch(() => {});
      } catch {
        // Disconnect/expiry also clears the connector's partial image.
      }
    }
    active.delete(transport);
  }
}
