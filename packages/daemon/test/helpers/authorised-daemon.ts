import { secret } from '@puddle/shared/node';
import { CONNECTION_POLICY } from '@puddle/shared';
import { startDaemon as start, type DaemonOptions } from '../../src/daemon.js';
import type { ConnectionAuthority } from '../../../cli/src/lib/auth/connection-authority.js';
import { onTeardown } from './process-guard.js';

/** Functional daemon tests own a host-side lease; production exposes no static token. */
export async function startDaemon(opts: DaemonOptions = {}) {
  const daemon = await start(opts);
  // A daemon the test forgets stops with the file (daemon.stop is idempotent).
  onTeardown(() => daemon.stop());
  const issued = daemon.authority.create();
  let token = issued.token;
  const resources = new Set<string>();
  const callbacks = new Map<string, () => void>();
  const timer = setInterval(() => {
    token = daemon.authority.renew(issued.generation, [...resources])?.token ?? token;
  }, CONNECTION_POLICY.participationMs);
  timer.unref();
  const connection: ConnectionAuthority = {
    state: 'ready',
    generation: issued.generation,
    credential: () => token,
    resource(close) {
      const id = secret();
      resources.add(id);
      callbacks.set(id, close);
      return {
        id,
        release: () => {
          resources.delete(id);
          callbacks.delete(id);
        },
        valid: () => daemon.authority.valid(token),
      };
    },
    onChange: () => () => {},
    close() {
      clearInterval(timer);
      daemon.authority.revoke(issued.generation);
      for (const close of callbacks.values()) close();
    },
  };
  return {
    ...daemon,
    connection,
    get token() {
      return token;
    },
    resourceId() {
      return connection.resource(() => {}).id;
    },
    async stop() {
      connection.close();
      await daemon.stop();
    },
  };
}
export type RunningDaemon = Awaited<ReturnType<typeof startDaemon>>;
