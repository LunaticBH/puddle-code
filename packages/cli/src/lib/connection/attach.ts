import type { ConnectionAuthority } from '../auth/connection-authority.js';
import type { Session } from '@puddle/shared';
import type { DaemonClient } from './daemon-client.js';
import { connectGateway } from '../transport/ws-client.js';
import { CliError } from '../types.js';

/** Ctrl-] — the telnet-style detach byte. */
const DETACH = 0x1d;

export interface AttachStreams {
  stdin: NodeJS.ReadStream | (NodeJS.ReadableStream & { isTTY?: boolean });
  stdout: NodeJS.WriteStream | (NodeJS.WritableStream & { columns?: number; rows?: number });
  stderr: NodeJS.WritableStream;
  /** SIGWINCH subscription — process.on in the bin, a no-op in tests. */
  onResize?: (cb: () => void) => () => void;
}

export interface AttachOptions {
  client: DaemonClient;
  /** Daemon-reachable port (tunnel local end when remote). */
  port: number;
  authority: ConnectionAuthority;
  session: string;
  term?: string;
  streams: AttachStreams;
}

export type AttachOutcome =
  | { kind: 'detached' }
  | { kind: 'exited'; code: number }
  | { kind: 'error'; message: string }
  | { kind: 'connection-lost' };

/** Resolve a session by exact id or unique prefix. */
export async function resolveSession(client: DaemonClient, idOrPrefix: string): Promise<Session> {
  const sessions = await client.sessions();
  const exact = sessions.find((s) => s.id === idOrPrefix);
  if (exact) return exact;
  const matches = sessions.filter((s) => s.id.startsWith(idOrPrefix));
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length === 0) {
    throw new CliError(
      'unknown_session',
      `no session matches '${idOrPrefix}'`,
      'list them with: puddle status',
    );
  }
  throw new CliError(
    'ambiguous_session',
    `'${idOrPrefix}' matches ${matches.length} sessions: ${matches.map((s) => s.id.slice(0, 8)).join(', ')}`,
  );
}

/**
 * Raw-terminal attach (SPEC §2 "Why no tmux"): replay then live output to
 * stdout, stdin forwarded byte-for-byte except Ctrl-] (detach), SIGWINCH
 * re-sent as a resize. The daemon's multi-viewer semantics apply — this is
 * just another viewer alongside any browser windows.
 */
export async function attachSession(opts: AttachOptions): Promise<AttachOutcome> {
  const { streams } = opts;
  const term = opts.term ?? 'agent';
  const session = await resolveSession(opts.client, opts.session);

  const stdin = streams.stdin as NodeJS.ReadStream;
  if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
  streams.stderr.write(`— attached to ${session.id.slice(0, 8)} (${term}); Ctrl-] detaches —\r\n`);

  const gateway = await connectGateway(opts.port, opts.authority);
  const dims = () => ({
    cols: (streams.stdout as NodeJS.WriteStream).columns ?? 80,
    rows: (streams.stdout as NodeJS.WriteStream).rows ?? 24,
  });
  gateway.send({ t: 'attach', session: session.id, term, ...dims() });

  return new Promise<AttachOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: AttachOutcome) => {
      if (settled) return;
      settled = true;
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
      stdin.removeListener('data', onStdin);
      unResize?.();
      gateway.close();
      resolve(outcome);
    };

    gateway.onMessage((message) => {
      switch (message.t) {
        case 'replay':
        case 'output':
          if (message.session === session.id && message.term === term) {
            streams.stdout.write(message.data);
          }
          break;
        case 'exit':
          if (message.session === session.id && message.term === term) {
            finish({ kind: 'exited', code: message.code });
          }
          break;
        case 'error':
          finish({ kind: 'error', message: message.message });
          break;
        default:
          break; // ignore unknown message types (wire rules)
      }
    });
    gateway.onClose(() => finish({ kind: 'connection-lost' }));

    const onStdin = (chunk: Buffer) => {
      const detachAt = chunk.indexOf(DETACH);
      if (detachAt !== -1) {
        const before = chunk.subarray(0, detachAt);
        if (before.length > 0) {
          gateway.send({ t: 'stdin', session: session.id, term, data: before.toString() });
        }
        gateway.send({ t: 'detach', session: session.id, term });
        finish({ kind: 'detached' });
        return;
      }
      gateway.send({ t: 'stdin', session: session.id, term, data: chunk.toString() });
    };
    stdin.on('data', onStdin);
    stdin.resume?.();

    const unResize = streams.onResize?.(() => {
      gateway.send({ t: 'resize', session: session.id, term, ...dims() });
    });
  });
}
