import {
  CONNECTION_POLICY,
  REMOTE_POLICY,
  relayMessageSchema,
  type RemoteAdminRequest,
  type RemoteAdminResponse,
  type RemoteMessage,
  type RemoteDevice,
  type WsClientMessage,
} from '@puddle/shared';
import { secureChannel, SocketWire, type EncryptedChannel } from '@puddle/remote-transport';
import type { BrowserTransport, CockpitSocket } from '../../lib/transport/browser-transport';
import type { BrowserHost } from './identity-store';
import { RemoteSocket } from './socket';

export type RemoteState = 'connecting' | 'pairing' | 'ready' | 'disconnected' | 'rejected';
interface Pending {
  resolve(value: RemoteMessage): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  cleanup(): void;
}

/** One host, one encryption generation. Reconnection restores views, never commands. */
export class RemoteClient implements BrowserTransport {
  get notificationHost(): string {
    return this.host.host;
  }
  readonly scope: string;
  state: RemoteState = 'connecting';
  pendingDevice: RemoteDevice | null = null;
  deviceId: string | null = null;
  generation: string | null = null;
  private ws: WebSocket | null = null;
  private channel: EncryptedChannel | null = null;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoff = 500;
  private until = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<() => void>();
  private readonly terminalListeners = new Set<(message: unknown) => void>();
  private streamId: string | null = null;
  constructor(
    readonly host: BrowserHost,
    private invitation?: string,
  ) {
    this.scope = JSON.stringify([host.service, host.account, host.host]);
  }
  onState(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onTerminal(listener: (message: unknown) => void): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }
  private setState(state: RemoteState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private available(): boolean {
    if (this.state !== 'ready' || !this.channel) return false;
    if (performance.now() >= this.until) {
      this.setState('disconnected');
      this.ws?.close();
      return false;
    }
    return true;
  }
  start(): void {
    if (this.stopped || this.ws || this.retry || this.state === 'rejected') return;
    this.setState('connecting');
    const url = new URL('/remote/browser', this.host.service);
    url.protocol = 'wss:';
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    let wire: SocketWire | null = null;
    const watchdog = setInterval(() => {
      if (this.state === 'ready') this.available();
    }, 1000);
    const readyTimeout = setTimeout(() => ws.close(), REMOTE_POLICY.handshakeMs);
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ t: 'connect', host: this.host.host })),
    );
    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return;
      if (wire) {
        if (!(event.data instanceof ArrayBuffer)) return ws.close();
        wire.receive(new Uint8Array(event.data));
        return;
      }
      try {
        const ready = relayMessageSchema.parse(JSON.parse(String(event.data)));
        if (ready.t !== 'ready' || ready.account !== this.host.account) return ws.close();
        clearTimeout(readyTimeout);
        wire = new SocketWire(ws, 'outbound');
        void secureChannel(
          wire,
          Uint8Array.from(this.host.privateKey),
          {
            service: this.host.service,
            host: this.host.host,
            hostPeer: this.host.peer,
            connection: ready.connection,
          },
          'outbound',
        )
          .then(async (channel) => {
            if (this.ws !== ws) {
              channel.close();
              return;
            }
            this.channel = channel;
            const invitation = this.invitation;
            this.invitation = undefined;
            await channel.send({
              t: 'hello',
              account: this.host.account,
              label: this.host.label,
              ...(invitation ? { invitation } : {}),
            });
            for await (const message of channel.messages()) {
              if (this.ws !== ws) break;
              await this.receive(message);
            }
          })
          .catch(() => ws.close());
      } catch {
        ws.close();
      }
    });
    ws.addEventListener('error', () => ws.close());
    ws.addEventListener('close', () => {
      clearInterval(watchdog);
      clearTimeout(readyTimeout);
      wire?.onTransportClosed();
      if (this.ws !== ws) return;
      this.ws = null;
      this.channel?.close();
      this.channel = null;
      this.generation = null;
      this.streamId = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.cleanup();
        pending.reject(
          new Error(
            'Connection interrupted; delivery may have occurred. Check the terminal before resending.',
          ),
        );
      }
      this.pending.clear();
      if (this.state !== 'rejected') this.setState('disconnected');
      if (!this.stopped && this.state !== 'rejected') {
        this.retry = setTimeout(() => {
          this.retry = null;
          this.start();
        }, this.backoff);
        this.backoff = Math.min(10_000, this.backoff * 2);
      }
    });
  }
  private async receive(message: RemoteMessage): Promise<void> {
    if (this.state === 'ready' && !this.available()) return;
    if (message.t === 'pending') {
      this.pendingDevice = message.device;
      this.setState('pairing');
    } else if (message.t === 'admitted') {
      this.generation = message.generation;
      this.deviceId = message.device;
      this.pendingDevice = null;
      this.backoff = 500;
      this.until = performance.now() + CONNECTION_POLICY.leaseMs;
      this.setState('ready');
    } else if (
      message.t === 'challenge' &&
      this.state === 'ready' &&
      message.generation === this.generation
    ) {
      this.until = performance.now() + CONNECTION_POLICY.leaseMs;
      await this.channel!.send({
        t: 'participate',
        nonce: message.nonce,
        generation: message.generation,
        resources: [...this.pending.keys(), ...(this.streamId ? [this.streamId] : [])].slice(
          0,
          REMOTE_POLICY.requests + 1,
        ),
      });
    } else if (message.t === 'event') {
      for (const listener of this.terminalListeners) listener(message.message);
    } else if (message.t === 'response' || message.t === 'sent' || message.t === 'admin-result') {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.cleanup();
        pending.resolve(message);
      }
    } else if (message.t === 'error') {
      this.setState(
        message.code === 'rejected' || message.code === 'expired' ? 'rejected' : 'disconnected',
      );
      this.ws?.close();
    } else throw new Error('Unexpected remote message');
  }
  private operation(
    message: RemoteMessage & { id: string },
    signal?: AbortSignal | null,
  ): Promise<RemoteMessage> {
    if (!this.available() || signal?.aborted)
      return Promise.reject(new Error('Connection is unavailable; nothing was sent'));
    if (this.pending.size >= REMOTE_POLICY.requests)
      return Promise.reject(new Error('Too many pending operations'));
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.cleanup();
        void this.channel?.send({ t: 'cancel', id: message.id }).catch(() => {});
        reject(new Error('Operation interrupted; delivery may have occurred'));
      };
      const timer = setTimeout(cancel, 30_000);
      const cleanup = () => signal?.removeEventListener('abort', cancel);
      this.pending.set(message.id, { resolve, reject, timer, cleanup });
      signal?.addEventListener('abort', cancel, { once: true });
      void this.channel!.send(message).catch(cancel);
    });
  }
  async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal | null,
  ): Promise<Response> {
    if (method !== 'GET' && method !== 'POST' && method !== 'PATCH')
      throw new Error('Operation is unavailable remotely');
    const response = await this.operation(
      {
        t: 'request',
        id: crypto.randomUUID(),
        method,
        path,
        ...(body === undefined ? {} : { body }),
      },
      signal,
    );
    if (response.t !== 'response') throw new Error('Invalid remote response');
    return new Response(response.status === 204 ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  async admin(request: RemoteAdminRequest): Promise<RemoteAdminResponse> {
    const response = await this.operation({ t: 'admin', id: crypto.randomUUID(), request });
    if (response.t !== 'admin-result') throw new Error('Invalid remote response');
    return response.result;
  }
  async input(session: string, term: string, data: string): Promise<void> {
    await this.operation({
      t: 'terminal',
      id: crypto.randomUUID(),
      message: { t: 'stdin', session, term, data },
    });
  }
  async terminal(message: WsClientMessage): Promise<void> {
    if (this.state !== 'ready' || !this.channel)
      throw new Error('Terminal is unavailable; nothing was sent');
    await this.channel!.send({ t: 'terminal', id: crypto.randomUUID(), message });
  }
  async openStream(): Promise<void> {
    if (!this.available()) throw new Error('Connection is unavailable');
    if (this.streamId) throw new Error('Terminal stream is already open');
    this.streamId = crypto.randomUUID();
    await this.channel!.send({ t: 'stream', id: this.streamId });
  }
  socket(): CockpitSocket {
    return new RemoteSocket(this);
  }
  restartConnection(): void {
    this.ws?.close();
  }
  close(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.channel?.close();
    this.ws?.close();
  }
}
