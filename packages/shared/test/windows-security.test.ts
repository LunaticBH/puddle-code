import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  atomicPrivateJson,
  initialisePrivateHome,
  ipcPath,
  listenPrivate,
  readPrivateJson,
} from '../src/node/security.js';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'puddle-windows-home-'));
  temporary.push(parent);
  return { parent, home: join(parent, '.puddle') };
}
const icacls = (path: string) =>
  execFileSync(join(process.env.SystemRoot!, 'System32', 'icacls.exe'), [path], {
    encoding: 'utf8',
    windowsHide: true,
  });

describe.skipIf(process.platform !== 'win32')('Windows Puddle home', () => {
  it('gives a new home a protected owner, SYSTEM and Administrators DACL', () => {
    const { home } = fixture();
    initialisePrivateHome(home);
    const acl = icacls(home);
    expect(acl).not.toContain('(I)'); // nothing inherited from the parent
    expect(acl.match(/\(OI\)\(CI\)\(F\)/g)).toHaveLength(3);
    // Files created inside inherit the same three entries.
    writeFileSync(join(home, 'file'), '');
    expect(icacls(join(home, 'file')).match(/\(I\)\(F\)/g)).toHaveLength(3);
  });

  it('leaves the ACL of an existing home alone', () => {
    const { home } = fixture();
    mkdirSync(home);
    const before = icacls(home);
    initialisePrivateHome(home);
    expect(icacls(home)).toBe(before);
  });

  it.each(['', '\\'])('refuses a junction as the home (suffix %j)', (suffix) => {
    const { parent, home } = fixture();
    const target = join(parent, 'target');
    mkdirSync(target);
    symlinkSync(target, home, 'junction');
    expect(() => initialisePrivateHome(home + suffix)).toThrow('symbolic link or junction');
    expect(readdirSync(target)).toEqual([]);
  });

  it('names pipes with the home key and a persisted private nonce', () => {
    const { home } = fixture();
    const host = ipcPath(home, 'host');
    const nonce = readFileSync(join(home, 'ipc-nonce'), 'utf8');
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(host).toMatch(new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\puddle-[0-9a-f]{24}-${nonce}$`));
    // CLI and daemon compute the same name; scopes differ only in the key.
    expect(ipcPath(home, 'host')).toBe(host);
    const other = ipcPath(home, 'connector');
    expect(other).not.toBe(host);
    expect(other.endsWith(`-${nonce}`)).toBe(true);
    // Another home has its own nonce.
    expect(ipcPath(fixture().home, 'host').endsWith(`-${nonce}`)).toBe(false);
  });

  it('refuses a malformed or redirected nonce', () => {
    const { parent, home } = fixture();
    mkdirSync(home);
    writeFileSync(join(home, 'ipc-nonce'), 'not-hex');
    expect(() => ipcPath(home, 'host')).toThrow('nonce is malformed');
    rmSync(join(home, 'ipc-nonce'));
    mkdirSync(join(parent, 'elsewhere'));
    symlinkSync(join(parent, 'elsewhere'), join(home, 'ipc-nonce'), 'junction');
    expect(() => ipcPath(home, 'host')).toThrow('must be a regular file');
  });

  it('reports an already-served pipe as an active control socket', async () => {
    const { home } = fixture();
    const path = ipcPath(home, 'host');
    const server = await listenPrivate(path, (socket) => socket.end());
    try {
      await expect(listenPrivate(path, () => {})).rejects.toThrow('already active');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('replaces private JSON while another process briefly holds the target open', async () => {
    const { home } = fixture();
    initialisePrivateHome(home);
    const target = join(home, 'state.json');
    atomicPrivateJson(target, { version: 1 });
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const fs = require('node:fs'); const fd = fs.openSync(${JSON.stringify(target)}, 'r');` +
          `process.stdout.write('open'); setTimeout(() => fs.closeSync(fd), 300);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    atomicPrivateJson(target, { version: 2 });
    expect(readPrivateJson(target)).toEqual({ version: 2 });
    expect(readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await new Promise((resolve) => holder.once('exit', resolve));
    expect(existsSync(target)).toBe(true);
  });
});
