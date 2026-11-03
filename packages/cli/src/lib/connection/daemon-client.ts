import {
  hostInfoSchema,
  profileSchema,
  sessionSchema,
  versionResponseSchema,
  type HostInfo,
  type Profile,
  type Session,
  type VersionResponse,
} from '@puddle/shared';
import type { ConnectionAuthority } from '../auth/connection-authority.js';
import { hostPaths } from '../paths.js';
import type { Transport } from '../transport/transport.js';
import { CliError } from '../types.js';

/** Statuses that count as "live" for upgrade-interruption warnings. */
const LIVE = new Set(['starting', 'running', 'waiting_input']);

/**
 * Authenticated client for the daemon API, pointed at 127.0.0.1:<port> —
 * the daemon directly in local mode, the tunnel's local end in SSH mode.
 */
export class DaemonClient {
  constructor(
    private port: number,
    private readonly authority: ConnectionAuthority,
  ) {}

  setPort(port: number): void {
    this.port = port;
  }

  private async get(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        headers: { authorization: `Bearer ${this.authority.credential()}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new CliError('daemon_unreachable', 'The Puddle daemon is not reachable.');
    }
    if (res.status === 401) {
      throw new CliError(
        'token_rejected',
        'connection authority was rejected by the daemon',
        'reconnect with puddle launch',
      );
    }
    if (!res.ok) {
      throw new CliError('daemon_unreachable', `the daemon answered ${res.status} for ${path}`);
    }
    return res.json();
  }

  version(): Promise<VersionResponse> {
    return this.get('/api/version').then((body) => versionResponseSchema.parse(body));
  }

  host(): Promise<HostInfo> {
    return this.get('/api/host').then((body) => hostInfoSchema.parse(body));
  }

  sessions(): Promise<Session[]> {
    return this.get('/api/sessions').then((body) => sessionSchema.array().parse(body));
  }

  profiles(): Promise<Profile[]> {
    return this.get('/api/profiles').then((body) => profileSchema.array().parse(body));
  }

  /** The live subset of sessions() — what an upgrade/removal interrupts. */
  async liveSessions(): Promise<Session[]> {
    return (await this.sessions()).filter((s) => LIVE.has(s.status));
  }
}

/**
 * Where to find the daemon on a host: the live port from runtime.json if the
 * daemon recorded one (it may have fallen back off a busy config port), else
 * config.json's preferred port, else the 7434 default. The caller must still
 * revalidate by token — a runtime.json can be stale after a crash.
 */
export async function readDaemonPort(transport: Transport): Promise<number> {
  const runtime = await transport.readFile(hostPaths.runtime);
  if (runtime !== null) {
    try {
      const parsed = JSON.parse(runtime) as { port?: unknown };
      if (typeof parsed.port === 'number') return parsed.port;
    } catch {
      // malformed runtime file falls through to the configured port
    }
  }
  const raw = await transport.readFile(hostPaths.config);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { port?: unknown };
      if (typeof parsed.port === 'number') return parsed.port;
    } catch {
      // unreadable config falls through to the default
    }
  }
  return 7434;
}
