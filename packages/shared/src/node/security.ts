import { execFileSync } from 'node:child_process';
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
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { CONTROL_MAX_BYTES } from '../api/connection/connection-auth.js';
import { normaliseHostPath } from '../host-path.js';
import { system32Path } from './environment.js';
import { renameWithRetrySync } from './rename.js';

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

/**
 * Check an `ipcPath` endpoint before connecting to it. A Unix socket is
 * checked like any private file. A Windows named pipe has no filesystem
 * metadata to check, and a stat would open it as a client: its privacy comes
 * from the nonce in its name, which only readers of the home can know. A
 * missing pipe surfaces as ENOENT from the connect itself.
 */
export function checkIpcEndpoint(path: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return;
  privatePath(path);
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
  if (process.platform === 'win32') return initialiseWindowsHome(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
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

/**
 * Windows has no mode bits: the profile's inherited ACL is owner-only, and
 * a home this call creates additionally receives a protected DACL for the
 * owner, SYSTEM and Administrators (docs/windows.md, decision 2). Reparse
 * points are refused as the POSIX symlink rule refuses symlinks; Node
 * reports junctions as symbolic links.
 */
function initialiseWindowsHome(path: string): void {
  let existing: Stats | null = null;
  try {
    existing = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing?.isSymbolicLink()) {
    throw new Error(`Puddle home must not be a symbolic link or junction: ${path}`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  privatePath(path, true);
  if (!existing) restrictWindowsDirectory(path);
}

let windowsUserSid: string | undefined;
let windowsAclWarned = false;

/** Best effort: a failure is reported once as a process warning and never thrown. */
function restrictWindowsDirectory(path: string): void {
  try {
    windowsUserSid ??= currentWindowsUserSid();
    execFileSync(
      system32Path('icacls.exe'),
      [
        path,
        '/inheritance:r',
        '/grant:r',
        `*${windowsUserSid}:(OI)(CI)F`,
        '*S-1-5-18:(OI)(CI)F',
        '*S-1-5-32-544:(OI)(CI)F',
      ],
      { windowsHide: true, timeout: 10_000, stdio: 'ignore' },
    );
  } catch (err) {
    if (windowsAclWarned) return;
    windowsAclWarned = true;
    process.emitWarning(
      `Could not restrict the new Puddle home to its owner, so it keeps its inherited ` +
        `permissions (${(err as Error).message}): ${path}`,
      { code: 'PUDDLE_HOME_ACL' },
    );
  }
}

function currentWindowsUserSid(): string {
  const output = execFileSync(system32Path('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    windowsHide: true,
    timeout: 10_000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  // `"host\user","S-1-5-21-…"`
  const sid = /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(output.trim())?.[1];
  if (!sid) throw new Error('whoami did not report a user SID');
  return sid;
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
    // One plain rename on POSIX; Windows retries while a reader holds the target.
    renameWithRetrySync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function readPrivateJson(path: string): unknown {
  privatePath(path);
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * Short paths also fit macOS's 104-byte sockaddr_un limit. Named pipes live
 * in one machine-wide namespace, so on Windows the name also carries the
 * home's private nonce: other users, who cannot read the home, can neither
 * connect to the pipe nor create it first.
 *
 * Every spelling of a Windows home names the same pipes: the key hashes the
 * home's on-disk path (`realpath.native`, upper-case drive letter, decision
 * 11), which the daemon's canonical home and a client's `d:\puddle` or 8.3
 * spelling share.
 */
export function ipcPath(home: string, scope: string): string {
  initialisePrivateHome(home);
  if (process.platform === 'win32') {
    const identity = normaliseHostPath(realpathSync.native(home));
    const key = digest(`${identity}\0${scope}`).slice(0, 24);
    return `\\\\.\\pipe\\puddle-${key}-${ipcNonce(home)}`;
  }
  const key = digest(`${realpathSync(home)}\0${scope}`).slice(0, 24);
  const dir = join('/tmp', `puddle-${process.getuid!()}-${key}`);
  privateDirectory(dir);
  return join(dir, 'control.sock');
}

const IPC_NONCE = /^[0-9a-f]{32}$/;

/** `<home>\ipc-nonce`: 32 random hex characters, created exclusively by whichever process needs it first. */
function ipcNonce(home: string): string {
  const path = join(home, 'ipc-nonce');
  const created = randomBytes(16).toString('hex');
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, created);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return created;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  for (let attempt = 0; ; attempt++) {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`Puddle IPC nonce must be a regular file: ${path}`);
    }
    const value = readFileSync(path, 'utf8');
    if (IPC_NONCE.test(value)) return value;
    // A concurrent creator may not have written it yet.
    if (value !== '' || attempt >= 50) throw new Error(`Puddle IPC nonce is malformed: ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
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
    // A served pipe cannot be probed and removed like a stale socket: its
    // listener already owns the name.
    const fail = (err: NodeJS.ErrnoException) =>
      reject(
        process.platform === 'win32' && err.code === 'EADDRINUSE'
          ? new Error('Puddle control socket is already active', { cause: err })
          : err,
      );
    server.once('error', fail);
    server.listen(path, () => {
      server.off('error', fail);
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
