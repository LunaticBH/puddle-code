import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { CONTROL_MAX_BYTES } from '../api/connection/connection-auth.js';
import { normaliseHostPath } from '../host-path.js';
import { renameWithRetrySync } from './rename.js';
import {
  currentWindowsUserSid,
  foreignPrincipals,
  readWindowsAcl,
  restrictWindowsDirectory,
  windowsAclProblem,
} from './windows-acl.js';

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
 * Windows has no mode bits. A home this call creates receives a protected
 * DACL for the owner, SYSTEM and Administrators (docs/windows.md, decision
 * 2; best effort, warned on failure). Inside the user's profile, whose
 * inherited ACL is owner-only, no other account can have created or opened
 * an existing home. Anywhere else (a `PUDDLE_HOME` such as `D:\puddle`) an
 * existing home is checked once per process, as the POSIX branch checks
 * one: another account's is refused, and one shared with other principals,
 * typically through a drive root's inherited ACL, receives the protected
 * DACL or is refused when it cannot. Reparse points are refused as the
 * POSIX symlink rule refuses symlinks; Node reports junctions as symbolic
 * links.
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
  if (!existing) restrictNewWindowsHome(path);
  // ipcPath runs this for every pipe name: PowerShell runs once per home.
  const identity = realpathSync.native(path).toLowerCase();
  if (verifiedWindowsHomes.has(identity)) return;
  if (!insideWindowsProfile(identity)) assertPrivateWindowsHome(path);
  verifiedWindowsHomes.add(identity);
}

const verifiedWindowsHomes = new Set<string>();
let windowsUserSid: string | undefined;
let windowsAclWarned = false;

/** Best effort: a failure is reported once as a process warning and never thrown. */
function restrictNewWindowsHome(path: string): void {
  try {
    windowsUserSid ??= currentWindowsUserSid();
    restrictWindowsDirectory(path, windowsUserSid);
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

/** `home` is the lower-cased real path. */
function insideWindowsProfile(home: string): boolean {
  let profile: string;
  try {
    profile = realpathSync.native(homedir()).toLowerCase();
  } catch {
    return false;
  }
  const relative = win32.relative(profile, home);
  return relative !== '' && !relative.startsWith('..') && !win32.isAbsolute(relative);
}

/** Never adopt a home another account owns or can open. */
function assertPrivateWindowsHome(path: string): void {
  const refusal = `Puddle home must be owned by the current user and not shared with other users: ${path}`;
  let problem: ReturnType<typeof windowsAclProblem>;
  try {
    windowsUserSid ??= currentWindowsUserSid();
    const acl = readWindowsAcl(path);
    problem = windowsAclProblem(acl, windowsUserSid);
    if (problem === 'shared') {
      restrictWindowsDirectory(path, windowsUserSid, foreignPrincipals(acl, windowsUserSid));
      problem = windowsAclProblem(readWindowsAcl(path), windowsUserSid);
    }
  } catch (err) {
    throw new Error(
      `Could not check the permissions of the Puddle home (${(err as Error).message}); ` +
        `a home inside your user profile needs no check: ${path}`,
      { cause: err },
    );
  }
  if (problem !== null) throw new Error(refusal);
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
 * in one machine-wide namespace that any local user can list, and a name
 * seen while it was served can be created by another user once it is not:
 * Windows clients therefore check that the server can read the home
 * (`ipcProof`), and the installer renames the home's pipes away from a
 * squatter (`rotateIpcNonce`). Each name is an HMAC under the home's
 * private `ipc-key` of its scope and the current nonce, so one visible name
 * reveals neither another scope's nor the next one.
 *
 * Every spelling of a Windows home names the same pipes: the HMAC covers the
 * home's on-disk path (`realpath.native`, upper-case drive letter, decision
 * 11), which the daemon's canonical home and a client's `d:\puddle` or 8.3
 * spelling share.
 */
export function ipcPath(home: string, scope: string): string {
  initialisePrivateHome(home);
  if (process.platform === 'win32') {
    return `${PIPES}${windowsPipeName(home, scope, ipcKey(home), ipcNonce(home))}`;
  }
  const key = digest(`${realpathSync(home)}\0${scope}`).slice(0, 24);
  const dir = join('/tmp', `puddle-${process.getuid!()}-${key}`);
  privateDirectory(dir);
  return join(dir, 'control.sock');
}

const PIPES = '\\\\.\\pipe\\';

function windowsPipeName(home: string, scope: string, key: string, nonce: string): string {
  const identity = normaliseHostPath(realpathSync.native(home));
  const name = createHmac('sha256', key)
    .update(`puddle-ipc-name\0${identity}\0${scope}\0${nonce}`)
    .digest('hex');
  return `puddle-${name.slice(0, 48)}`;
}

/** `<home>\ipc-key`: 64 random hex characters, keying pipe names and server proofs. */
const ipcKey = (home: string) => homeSecret(join(home, 'ipc-key'), 32, 'IPC key');
/** `<home>\ipc-nonce`: 32 random hex characters, replaced to rename every pipe. */
const ipcNonce = (home: string) => homeSecret(join(home, 'ipc-nonce'), 16, 'IPC nonce');

/**
 * Give every Windows pipe of the home a new name. Only for a name that a
 * server which cannot read the home holds: the installer does this under its
 * lock, before it starts a daemon, so the squatted name is never used again.
 */
export function rotateIpcNonce(home: string): void {
  const path = join(home, 'ipc-nonce');
  const tmp = `${path}.${secret()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, randomBytes(16).toString('hex'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameWithRetrySync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** A fresh challenge for a pipe server to answer with `ipcProof`. */
export function ipcChallenge(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The answer to `challenge` from a server of `scope`, keyed by the home's
 * `ipc-key`. That key never leaves the home (a pipe name is a one-way HMAC
 * under it), so only a process that can read the home can answer: a
 * Windows client accepts no reply from a pipe server until it has checked
 * one.
 */
export function ipcProof(home: string, scope: string, challenge: string): string {
  return createHmac('sha256', ipcKey(home))
    .update(`puddle-ipc-proof\0${scope}\0${challenge}`)
    .digest('hex');
}

export function checkIpcProof(
  home: string,
  scope: string,
  challenge: string,
  proof: string | undefined,
): boolean {
  if (proof === undefined || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return timingSafeEqual(
    Buffer.from(proof, 'hex'),
    Buffer.from(ipcProof(home, scope, challenge), 'hex'),
  );
}

/** Random hex in the home, created exclusively by whichever process needs it first. */
function homeSecret(path: string, bytes: number, name: string): string {
  const created = randomBytes(bytes).toString('hex');
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
  const pattern = new RegExp(`^[0-9a-f]{${bytes * 2}}$`);
  for (let attempt = 0; ; attempt++) {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`Puddle ${name} must be a regular file: ${path}`);
    }
    const value = readFileSync(path, 'utf8');
    if (pattern.test(value)) return value;
    // A concurrent creator may not have written it yet.
    if (value !== '' || attempt >= 50) throw new Error(`Puddle ${name} is malformed: ${path}`);
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
