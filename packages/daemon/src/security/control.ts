import {
  CONNECTION_POLICY,
  controlRequestSchema,
  type ControlResponse,
  type VersionResponse,
} from '@puddle/shared';
import { ipcPath, ipcProof, jsonLines, listenPrivate } from '@puddle/shared/node';
import type { Socket } from 'node:net';
import type { LeaseRegistry } from './leases.js';

/**
 * Socket directory ownership is the bootstrap authority; HTTP tokens cannot enter here.
 *
 * `onShutdown` enables the protocol 25.7 `shutdown` request: whoever can open
 * the private channel may already mint leases, so it may also stop the
 * daemon. Without it the request is answered as a pre-25.7 daemon would.
 *
 * A request that carries a `challenge` (Windows clients, 25.7) is answered
 * with its `proof`, showing that this server can read the home; requests
 * without one are answered exactly as before.
 */
export async function startHostControl(
  home: string,
  registry: LeaseRegistry,
  info: () => { port: number; version: VersionResponse } | null,
  onShutdown?: () => void,
) {
  const sockets = new Set<Socket>();
  const server = await listenPrivate(ipcPath(home, 'host'), (socket) => {
    sockets.add(socket);
    let generation: string | undefined;
    const send = (message: ControlResponse) => socket.write(JSON.stringify(message) + '\n');
    const fail = (proof: { proof?: string } = {}) => {
      send({ t: 'error', code: 'invalid_control', ...proof });
      socket.destroy();
    };
    const stop = jsonLines(
      socket,
      (value) => {
        const parsed = controlRequestSchema.safeParse(value);
        if (!parsed.success) return fail();
        const message = parsed.data;
        const proof =
          'challenge' in message && message.challenge !== undefined
            ? { proof: ipcProof(home, 'host', message.challenge) }
            : {};
        if (message.t === 'shutdown' && !onShutdown) return fail(proof);
        const ready = info();
        if (!ready) {
          send({ t: 'error', code: 'unavailable', ...proof });
          socket.end();
          return;
        }
        if (message.t === 'shutdown') {
          // Acknowledge first: stopping closes this channel with the others.
          socket.end(
            JSON.stringify({ t: 'shutting_down', ...proof } satisfies ControlResponse) + '\n',
          );
          if (generation) registry.revoke(generation);
          onShutdown!();
          return;
        }
        if (message.t === 'close') {
          socket.end();
          if (generation) registry.revoke(generation);
          return;
        }
        if (message.t === 'open') {
          if (generation) return fail();
          const issued = registry.create(message.profile);
          generation = issued.generation;
          send({
            t: 'authority',
            ...issued,
            ...ready,
            validForMs: CONNECTION_POLICY.leaseMs,
            ...proof,
          });
        } else {
          const renewed = generation && registry.renew(generation, message.resources);
          if (!renewed) {
            send({ t: 'error', code: 'rejected' });
            socket.end();
            return;
          }
          send({ t: 'authority', ...renewed, ...ready, validForMs: CONNECTION_POLICY.leaseMs });
        }
      },
      fail,
    );
    socket.setTimeout(CONNECTION_POLICY.leaseMs, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('end', () => {
      if (generation) registry.revoke(generation);
    });
    socket.on('close', () => {
      stop();
      sockets.delete(socket);
      if (generation) registry.revoke(generation);
    });
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
