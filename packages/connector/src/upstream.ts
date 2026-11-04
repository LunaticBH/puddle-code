import { connect } from 'node:net';
import WebSocket from 'ws';
import {
  REMOTE_POLICY,
  versionResponseSchema,
  wsServerMessageSchema,
  type RemoteMessage,
  type PushPreference,
} from '@puddle/shared';
import { checkIpcEndpoint, ipcPath } from '@puddle/shared/node';
import { HostControlClient, homeDaemonProof } from '@puddle/shared/node/host-control';
import type { EncryptedChannel } from '@puddle/remote-transport';
import { permittedRequest, permittedTerminal } from './policy.js';
import { ImageUploads, ImageUploadError } from './image-uploads.js';

/** The only code which constructs daemon requests. Destinations and credentials are host-owned. */
export class RemoteUpstream {
  readonly authority: HostControlClient;
  private socket: WebSocket | null = null;
  private authenticated = false;
  private readonly resources = new Map<string, { id: string; release(): void; valid(): boolean }>();
  private readonly requests = new Map<string, AbortController>();
  private readonly used = new Set<string>();
  private readonly uploads = new ImageUploads();
  constructor(
    home: string,
    private readonly channel: Pick<EncryptedChannel, 'send'>,
    private readonly valid: () => boolean,
    private readonly close: () => void,
    profile: string,
    private readonly notifications?: {
      update(value: PushPreference, signal: AbortSignal, current: () => boolean): Promise<unknown>;
      test(signal: AbortSignal): Promise<unknown>;
    },
  ) {
    this.authority = new HostControlClient(
      async () => {
        const path = ipcPath(home, 'host');
        checkIpcEndpoint(path);
        return connect(path);
      },
      false,
      undefined,
      profile,
      // Windows: a squatter on the host pipe must not receive remote traffic.
      process.platform === 'win32' ? homeDaemonProof(home) : undefined,
    );
    this.authority.onChange(() => {
      if (this.authority.state !== 'ready') close();
    });
  }
  participate(ids: string[], at: number): boolean {
    return this.authority.participate(
      ids.flatMap((id) => {
        const resource = this.resources.get(id);
        return resource ? [resource.id] : [];
      }),
      at,
    );
  }
  reserve(id: string): void {
    if (this.used.has(id) || this.used.size >= 100_000)
      throw new Error('Duplicate or exhausted request identifier');
    this.used.add(id);
  }
  openStream(id: string): void {
    this.reserve(id);
    if (this.socket || !this.valid()) throw new Error('Terminal stream is unavailable');
    const resource = this.authority.resource(this.close);
    this.resources.set(id, resource);
    const socket = new WebSocket(`ws://127.0.0.1:${this.authority.port}/ws`, {
      maxPayload: REMOTE_POLICY.responseBytes,
    });
    this.socket = socket;
    const timer = setTimeout(this.close, REMOTE_POLICY.handshakeMs);
    socket.on('open', () => {
      if (!this.valid() || !resource.valid()) return this.close();
      socket.send(
        JSON.stringify({ t: 'auth', token: this.authority.credential(), resource: resource.id }),
      );
    });
    socket.on('message', (raw) => {
      if (!this.valid() || !resource.valid()) return this.close();
      try {
        const parsed = wsServerMessageSchema.safeParse(JSON.parse(String(raw)));
        if (!parsed.success) return; // Additive daemon message types may be unknown.
        const message = parsed.data;
        if (!this.authenticated) {
          if (
            typeof message !== 'object' ||
            message === null ||
            !('t' in message) ||
            message.t !== 'authenticated'
          )
            return this.close();
          this.authenticated = true;
          clearTimeout(timer);
        }
        void this.channel.send({ t: 'event', message }).catch(this.close);
      } catch {
        this.close();
      }
    });
    socket.on('error', this.close);
    socket.on('close', () => {
      clearTimeout(timer);
      this.close();
    });
  }
  async terminal(message: Extract<RemoteMessage, { t: 'terminal' }>): Promise<void> {
    this.reserve(message.id);
    const input = permittedTerminal(message.message);
    if (!this.valid() || !this.authenticated || this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('Terminal is unavailable');
    if (this.socket.bufferedAmount > REMOTE_POLICY.queueBytes)
      throw new Error('Terminal is backpressured');
    await new Promise<void>((resolve, reject) => {
      this.socket!.send(JSON.stringify(input), (error) => (error ? reject(error) : resolve()));
    });
    if (this.valid()) await this.channel.send({ t: 'sent', id: message.id });
  }
  async request(message: Extract<RemoteMessage, { t: 'request' }>): Promise<void> {
    this.reserve(message.id);
    const request = permittedRequest(message);
    if (!this.valid() || this.requests.size >= REMOTE_POLICY.requests)
      throw new Error('Request capacity is unavailable');
    const abort = new AbortController();
    this.requests.set(message.id, abort);
    const resource = this.authority.resource(() => abort.abort());
    this.resources.set(message.id, resource);
    let releaseUpload: (() => void) | undefined;
    try {
      if (!this.valid() || !resource.valid() || abort.signal.aborted) return;
      if (request.notification) {
        if (!this.notifications) throw new Error('Background notifications are unavailable');
        const current = () => this.valid() && resource.valid() && !abort.signal.aborted;
        const body =
          request.notification === 'test'
            ? await this.notifications.test(abort.signal)
            : await this.notifications.update(request.notification, abort.signal, current);
        if (current())
          await this.channel.send({ t: 'response', id: message.id, status: 200, body });
        return;
      }
      if (request.upload) {
        const result = this.uploads.accept(request.path.split('/')[3]!, request.upload, abort);
        if ('progress' in result) {
          await this.channel.send({
            t: 'response',
            id: message.id,
            status: 200,
            body: result.progress,
          });
          return;
        }
        releaseUpload = result.release;
        // Only the validated finish operation can construct this larger host-local request.
        // Every browser request, including each image chunk, retains the 256 KiB cap.
        request.path = request.path.slice(0, -'-upload'.length);
        request.body = JSON.stringify(result.paste);
      }
      // Recheck immediately before dispatch. No browser URL, header, or credential reaches fetch.
      if (!this.valid() || !resource.valid() || abort.signal.aborted) return;
      const response = await fetch(`http://127.0.0.1:${this.authority.port}${request.path}`, {
        method: request.method,
        body: request.body,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.authority.credential()}`,
          'x-puddle-resource': resource.id,
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${this.authority.port}`,
        },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
      });
      let body: unknown = null;
      if (response.body) {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for await (const chunk of response.body) {
          if (!this.valid() || !resource.valid()) {
            abort.abort();
            return;
          }
          bytes += chunk.byteLength;
          if (bytes > REMOTE_POLICY.responseBytes) throw new Error('Response is too large');
          chunks.push(chunk);
        }
        if (bytes) body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      }
      if (request.path === '/api/version' && response.ok) {
        const version = versionResponseSchema.parse(body);
        const push =
          this.notifications &&
          (version.protocol.major > 22 ||
            (version.protocol.major === 22 && version.protocol.minor >= 4));
        body = {
          ...version,
          remote_image_uploads: true,
          ...(push
            ? {
                remote_notifications: true,
                remote_notification_previews:
                  version.protocol.major > 22 || version.protocol.minor >= 5,
              }
            : {}),
        };
      }
      if (this.valid() && !abort.signal.aborted)
        await this.channel.send({ t: 'response', id: message.id, status: response.status, body });
    } catch (error) {
      abort.abort();
      if (this.valid() && this.requests.has(message.id))
        await this.channel.send({
          t: 'response',
          id: message.id,
          status: error instanceof ImageUploadError ? error.status : 502,
          body: {
            error: {
              code:
                error instanceof ImageUploadError ? 'image_upload_failed' : 'upstream_unavailable',
              message:
                error instanceof ImageUploadError
                  ? error.message
                  : 'Connection interrupted; the operation may have taken effect.',
            },
          },
        });
    } finally {
      releaseUpload?.();
      resource.release();
      this.resources.delete(message.id);
      this.requests.delete(message.id);
    }
  }
  cancel(id: string): void {
    this.requests.get(id)?.abort();
    this.requests.delete(id);
  }
  dispose(): void {
    this.uploads.dispose();
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    this.resources.clear();
    this.socket?.terminate();
    this.authority.close();
  }
}
