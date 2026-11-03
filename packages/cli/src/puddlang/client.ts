import {
  puddlangContextSchema,
  puddlangRunSchema,
  puddlangEventsSchema,
  type PuddlangStart,
} from '@puddle/shared';
import { acquireAuthority, type ConnectionAuthority } from '../lib/auth/connection-authority.js';
import { DaemonClient } from '../lib/connection/daemon-client.js';
import { LocalTransport } from '../lib/transport/local.js';
import { SshTransport } from '../lib/transport/ssh.js';
import { openTunnel, type Tunnel } from '../lib/transport/tunnel.js';

/** A profile is selected once, on the execution host; no credentials enter programmes. */
export class PuddlangClient {
  constructor(
    private readonly port: () => number,
    private readonly authority: ConnectionAuthority,
    readonly profile: string,
  ) {}

  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(
      `http://127.0.0.1:${this.port()}/api/puddlang/${encodeURIComponent(this.profile)}${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${this.authority.credential()}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(
        `Puddlang request failed (${response.status}): ${(await response.text()).slice(0, 2048)}`,
      );
    return response.json();
  }
  async context() {
    return puddlangContextSchema.parse(await this.request('/context'));
  }
  async start(input: PuddlangStart) {
    return puddlangRunSchema.parse(await this.request('/runs', input));
  }
  async status(id: string) {
    return puddlangRunSchema.parse(await this.request(`/runs/${encodeURIComponent(id)}`));
  }
  async events(id: string, after = 0) {
    return puddlangEventsSchema.parse(
      await this.request(`/runs/${encodeURIComponent(id)}/events?after=${after}`),
    );
  }
  async cancel(id: string) {
    return puddlangRunSchema.parse(
      await this.request(`/runs/${encodeURIComponent(id)}/cancel`, {}),
    );
  }
}

export async function connectPuddlang(host?: string, selector?: string) {
  const transport = host ? new SshTransport(host) : new LocalTransport();
  let authority: Awaited<ReturnType<typeof acquireAuthority>> | undefined;
  let tunnel: Tunnel | undefined;
  const close = async () => {
    authority?.close();
    await tunnel?.close();
    transport.dispose();
  };
  try {
    if (transport instanceof SshTransport) await transport.open();
    authority = await acquireAuthority(transport);
    if (transport instanceof SshTransport) tunnel = await openTunnel(transport, authority.port);
    const port = () => tunnel?.localPort ?? authority!.port;
    const daemon = new DaemonClient(port(), authority);
    const { protocol } = await daemon.version();
    if (protocol.major !== 24)
      throw new Error(
        'This pudl version requires daemon protocol 24.0+ within major 24 for headless mode. Upgrade the daemon with puddle upgrade daemon.',
      );
    const profiles = await daemon.profiles();
    const matches = selector
      ? profiles.filter((p) => p.id === selector || p.name === selector)
      : profiles;
    if (matches.length !== 1)
      throw new Error(
        `Select --profile on the execution host: ${profiles.map((p) => `${p.name} (${p.id})`).join(', ')}`,
      );
    return { client: new PuddlangClient(port, authority, matches[0]!.id), close };
  } catch (error) {
    await close();
    throw error;
  }
}
