import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { CONTROL_MAX_BYTES } from '../api/connection/connection-auth.js';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const secret = (prefix = ''): string => prefix + randomBytes(32).toString('hex');

/** Refuse symlinks and shared state before trusting its contents. */
export function privatePath(path: string, directory = false): void {
  const st = lstatSync(path);
  if (
    st.isSymbolicLink() ||
    (directory ? !st.isDirectory() : !st.isFile() && !st.isSocket()) ||
    (process.getuid && st.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (st.mode & 0o077) !== 0)
  ) {
    throw new Error('Puddle authority storage must be private and owned by the current user');
  }
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  privatePath(path, true);
}

/**
 * Older installers and client state writers created the Puddle home as 0755.
 * Migrate that root before using authority; existing authority directories
 * and files still go through the strict privateDirectory/privatePath checks.
 */
export function initialisePrivateHome(home: string): void {
  const path = resolve(home);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    privatePath(path, true);
    return;
  }
  // Operate on the verified directory itself, without following a symlink or
  // chmodding a replacement path. Never adopt state another user could write.
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o022) !== 0) {
      throw new Error(
        `Puddle home must be owned by the current user and not writable by other users: ${path}`,
      );
    }
    if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
  privatePath(path, true);
}

export function atomicPrivateJson(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  const tmp = `${path}.${secret()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function readPrivateJson(path: string): unknown {
  privatePath(path);
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** Short paths also fit macOS's 104-byte sockaddr_un limit. */
export function ipcPath(home: string, scope: string): string {
  initialisePrivateHome(home);
  const key = digest(`${realpathSync(home)}\0${scope}`).slice(0, 24);
  if (process.platform === 'win32') return `\\\\.\\pipe\\puddle-${key}`;
  const dir = join('/tmp', `puddle-${process.getuid!()}-${key}`);
  privateDirectory(dir);
  return join(dir, 'control.sock');
}

export async function listenPrivate(
  path: string,
  onConnection: (socket: Socket) => void,
): Promise<Server> {
  if (process.platform !== 'win32') {
    try {
      privatePath(path);
      const before = lstatSync(path);
      if (!before.isSocket()) throw new Error('Puddle control path is not a socket');
      const stale = await new Promise<boolean>((resolve, reject) => {
        const probe = connect(path);
        probe.once('connect', () => {
          probe.destroy();
          resolve(false);
        });
        probe.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') resolve(true);
          else reject(err);
        });
      });
      if (!stale) throw new Error('Puddle control socket is already active');
      const after = lstatSync(path);
      if (after.ino !== before.ino) throw new Error('Puddle control socket changed during startup');
      rmSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const server = createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
  return server;
}

/** Newline framing is bounded even when an attacker never sends a newline. */
export function jsonLines(
  stream: NodeJS.ReadableStream,
  receive: (value: unknown) => void,
  fail: () => void,
): () => void {
  let buffer = '';
  let failed = false;
  const onData = (chunk: Buffer | string) => {
    if (failed) return;
    buffer += chunk.toString();
    if (Buffer.byteLength(buffer) > CONTROL_MAX_BYTES) {
      failed = true;
      fail();
      return;
    }
    let end: number;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        receive(JSON.parse(line) as unknown);
      } catch {
        failed = true;
        fail();
        return;
      }
    }
  };
  stream.on('data', onData);
  return () => stream.off('data', onData);
}
