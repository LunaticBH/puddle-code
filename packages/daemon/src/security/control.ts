import {
  CONNECTION_POLICY,
  controlRequestSchema,
  type ControlResponse,
  type VersionResponse,
} from '@puddle/shared';
import { ipcPath, jsonLines, listenPrivate } from '@puddle/shared/node';
import type { Socket } from 'node:net';
import type { LeaseRegistry } from './leases.js';

/** Socket directory ownership is the bootstrap authority; HTTP tokens cannot enter here. */
export async function startHostControl(
  home: string,
  registry: LeaseRegistry,
  info: () => { port: number; version: VersionResponse } | null,
) {
  const sockets = new Set<Socket>();
  const server = await listenPrivate(ipcPath(home, 'host'), (socket) => {
    sockets.add(socket);
    let generation: string | undefined;
    const send = (message: ControlResponse) => socket.write(JSON.stringify(message) + '\n');
    const fail = () => {
      send({ t: 'error', code: 'invalid_control' });
      socket.destroy();
    };
    const stop = jsonLines(
      socket,
      (value) => {
        const parsed = controlRequestSchema.safeParse(value);
        if (!parsed.success) return fail();
        const message = parsed.data;
        // Protocol 25.7 defines `shutdown`; until the daemon implements a
        // graceful stop it answers exactly as a pre-25.7 daemon would.
        if (message.t === 'shutdown') return fail();
        const ready = info();
        if (!ready) {
          send({ t: 'error', code: 'unavailable' });
          socket.end();
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
          send({ t: 'authority', ...issued, ...ready, validForMs: CONNECTION_POLICY.leaseMs });
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
