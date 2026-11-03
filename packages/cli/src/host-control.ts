import { connect } from 'node:net';
import { controlRequestSchema, controlResponseSchema } from '@puddle/shared';
import { checkIpcEndpoint, ipcPath, jsonLines } from '@puddle/shared/node';
import { clientHome } from './lib/paths.js';
import { inspectHostLocally } from './lib/auth/host-inspection.js';

// stdout is exclusively the bounded control protocol; diagnostics never contain credentials.
if (process.argv.includes('--inspect')) {
  const inspection = await inspectHostLocally(clientHome()).catch(() => ({
    t: 'error',
    code: 'rejected',
  }));
  process.stdout.write(JSON.stringify(inspection ?? { t: 'error', code: 'unavailable' }) + '\n');
} else {
  const path = ipcPath(clientHome(), 'host');
  checkIpcEndpoint(path);
  const socket = connect(path);
  const stop = () => {
    socket.destroy();
    process.stdin.destroy();
  };
  jsonLines(
    process.stdin,
    (value) => {
      const message = controlRequestSchema.parse(value);
      if (!socket.write(JSON.stringify(message) + '\n')) process.stdin.pause();
    },
    stop,
  );
  jsonLines(
    socket,
    (value) => {
      const message = controlResponseSchema.parse(value);
      if (!process.stdout.write(JSON.stringify(message) + '\n')) socket.pause();
    },
    stop,
  );
  socket.on('drain', () => process.stdin.resume());
  process.stdout.on('drain', () => socket.resume());
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  process.stdout.on('error', stop);
  socket.on('error', stop);
  socket.on('close', stop);
}
