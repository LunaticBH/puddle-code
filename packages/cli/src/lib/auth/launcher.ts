import { rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  atomicPrivateJson,
  digest,
  ipcPath,
  jsonLines,
  listenPrivate,
  privatePath,
  readPrivateJson,
  secret,
} from '@puddle/shared/node';
import {
  launcherRequestSchema,
  launcherResponseSchema,
  launcherShutdownResponseSchema,
} from '@puddle/shared';

// Windows named pipes use an additional owner-stored secret, never the registry.
function secretFile(home: string, path: string) {
  return join(home, 'launcher-authority', digest(path) + '.json');
}
/** `onShutdown` admits the launcher `shutdown` request; without it the request is refused. */
export async function startLauncher(
  home: string,
  identity: string,
  invite: () => string,
  onShutdown?: () => void,
) {
  const path = ipcPath(home, `launcher:${identity}`);
  const pipeSecret = process.platform === 'win32' ? secret() : undefined;
  if (pipeSecret) atomicPrivateJson(secretFile(home, path), { secret: pipeSecret });
  const sockets = new Set<Socket>();
  const server = await listenPrivate(path, (socket) => {
    sockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    let used = false;
    jsonLines(
      socket,
      (value) => {
        const request = launcherRequestSchema.parse(value);
        if (used || (pipeSecret && digest(request.secret ?? '') !== digest(pipeSecret)))
          return socket.destroy();
        used = true;
        if (request.t === 'shutdown') {
          if (!onShutdown) return socket.destroy();
          socket.end(JSON.stringify({ t: 'stopping' }) + '\n');
          onShutdown();
          return;
        }
        socket.end(JSON.stringify({ url: invite() }) + '\n');
      },
      () => socket.destroy(),
    );
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    path,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (pipeSecret) rmSync(secretFile(home, path), { force: true });
    },
  };
}
export async function requestInvitation(home: string, path: string): Promise<string> {
  return (await launcherRequest(home, path, 'invite', launcherResponseSchema.parse)).url;
}
/** Ask a cockpit to stop itself; resolves once it has acknowledged. */
export async function requestCockpitShutdown(home: string, path: string): Promise<void> {
  await launcherRequest(home, path, 'shutdown', launcherShutdownResponseSchema.parse);
}
async function launcherRequest<T>(
  home: string,
  path: string,
  t: 'invite' | 'shutdown',
  parse: (value: unknown) => T,
): Promise<T> {
  let pipeSecret: string | undefined;
  if (process.platform === 'win32') {
    const stored = readPrivateJson(secretFile(home, path)) as { secret: string };
    pipeSecret = stored.secret;
  } else privatePath(path);
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.setTimeout(5000, () => socket.destroy(new Error('Launcher did not answer')));
    jsonLines(
      socket,
      (value) => {
        const message = parse(value);
        resolve(message);
        socket.end();
      },
      () => socket.destroy(new Error('Invalid launcher reply')),
    );
    socket.on('error', reject);
    socket.on('close', () =>
      reject(
        new Error(`Launcher closed without ${t === 'invite' ? 'an invitation' : 'an answer'}`),
      ),
    );
    socket.write(JSON.stringify({ t, ...(pipeSecret ? { secret: pipeSecret } : {}) }) + '\n');
  });
}
