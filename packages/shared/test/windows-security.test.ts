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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  atomicPrivateJson,
  initialisePrivateHome,
  ipcPath,
  listenPrivate,
  readPrivateJson,
  rotateIpcNonce,
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

  it('leaves the ACL of an existing home in the profile alone', () => {
    const { home } = fixture();
    mkdirSync(home);
    const before = icacls(home);
    initialisePrivateHome(home);
    expect(icacls(home)).toBe(before);
  });

  describe('outside the profile', () => {
    // tmpdir() is inside the profile, so another folder plays the profile here.
    const savedProfile = process.env.USERPROFILE;
    beforeEach(() => {
      process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'puddle-other-profile-'));
      temporary.push(process.env.USERPROFILE);
    });
    afterEach(() => {
      process.env.USERPROFILE = savedProfile;
    });
    const grant = (path: string, ...entries: string[]) =>
      execFileSync(
        join(process.env.SystemRoot!, 'System32', 'icacls.exe'),
        [path, '/grant', ...entries],
        {
          windowsHide: true,
        },
      );

    it('leaves an existing owner-only home alone', () => {
      const { home } = fixture();
      mkdirSync(home);
      const before = icacls(home);
      initialisePrivateHome(home);
      expect(icacls(home)).toBe(before);
    });

    it('gives a home that others can open the protected DACL, inside it too', () => {
      // As under C:\ or D:\: inherited Authenticated Users Modify, plus an explicit Everyone read.
      const { parent, home } = fixture();
      grant(parent, '*S-1-5-11:(OI)(CI)M');
      mkdirSync(join(home, 'logs'), { recursive: true });
      writeFileSync(join(home, 'logs', 'cockpit.log'), '');
      grant(home, '*S-1-1-0:(OI)(CI)R');
      expect(icacls(home)).toMatch(/\(M\)/);
      initialisePrivateHome(home);
      const acl = icacls(home);
      expect(acl).not.toContain('(I)');
      expect(acl.match(/\(OI\)\(CI\)\(F\)/g)).toHaveLength(3);
      expect(acl).not.toMatch(/\((M|R)\)/);
      expect(icacls(join(home, 'logs', 'cockpit.log')).match(/\(I\)\(F\)/g)).toHaveLength(3);
    });

    it('checks a home it creates entry by entry, and leaves no marker once it passes', () => {
      const { home } = fixture();
      initialisePrivateHome(home);
      expect(icacls(home)).not.toContain('(I)');
      expect(existsSync(join(home, 'unverified'))).toBe(false);
    });

    it('keeps refusing a shared home holding a link another user could have planted', () => {
      // A junction to a folder another account controls, made while the home was open.
      const { parent, home } = fixture();
      grant(parent, '*S-1-5-11:(OI)(CI)M');
      const theirs = join(parent, 'theirs');
      mkdirSync(theirs);
      writeFileSync(join(theirs, 'node.exe'), '');
      mkdirSync(join(home, 'bin', 'versions'), { recursive: true });
      symlinkSync(theirs, join(home, 'bin', 'versions', '1.2.3'), 'junction');
      expect(() => initialisePrivateHome(home)).toThrow(/versions\\1\.2\.3, which is a link/);
      // Repaired meanwhile, so nothing else gets in; still refused by every later process.
      expect(icacls(home)).not.toMatch(/\(M\)/);
      expect(() => initialisePrivateHome(home)).toThrow('which is a link');
      expect(() => ipcPath(home, 'host')).toThrow('which is a link');
      expect(existsSync(join(home, 'ipc-key'))).toBe(false);
      rmSync(join(home, 'bin', 'versions', '1.2.3'));
      initialisePrivateHome(home);
      expect(existsSync(join(home, 'unverified'))).toBe(false);
    });

    it('replaces the IPC key and nonce of a home others could read', () => {
      const { parent, home } = fixture();
      grant(parent, '*S-1-5-11:(OI)(CI)M');
      mkdirSync(home);
      writeFileSync(join(home, 'ipc-key'), 'a'.repeat(64));
      writeFileSync(join(home, 'ipc-nonce'), 'b'.repeat(32));
      initialisePrivateHome(home);
      const key = readFileSync(join(home, 'ipc-key'), 'utf8');
      const nonce = readFileSync(join(home, 'ipc-nonce'), 'utf8');
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).not.toBe('a'.repeat(64));
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(nonce).not.toBe('b'.repeat(32));
      expect(existsSync(join(home, 'unverified'))).toBe(false);
    });

    it('leaves a shared home whose daemon is running until it stops, then rekeys it', async () => {
      // Each process checks a home once: fresh module instances play later processes.
      const fresh = async () => {
        vi.resetModules();
        return import('../src/node/security.js');
      };
      const { home } = fixture();
      const first = await fresh();
      const served = first.ipcPath(home, 'host');
      const daemon = await first.listenPrivate(served, (socket) => socket.end());
      grant(home, '*S-1-5-11:(OI)(CI)M');
      try {
        const second = await fresh();
        expect(() => second.initialisePrivateHome(home)).toThrow(
          'Puddle is running from this home',
        );
        // Renaming its pipes now would orphan the daemon: the home is left as it was.
        expect(icacls(home)).toMatch(/\(M\)/);
      } finally {
        await new Promise<void>((resolve) => daemon.close(() => resolve()));
      }
      const third = await fresh();
      expect(third.ipcPath(home, 'host')).not.toBe(served);
      expect(icacls(home)).not.toMatch(/\(M\)/);
    });
  });

  it('names the same pipes for every spelling of the home', () => {
    const { home } = fixture();
    const host = ipcPath(home, 'host');
    // The daemon canonicalises its home; a CLI passes PUDDLE_HOME as typed.
    expect(ipcPath(home[0]!.toLowerCase() + home.slice(1), 'host')).toBe(host);
    expect(ipcPath(home.toUpperCase(), 'host')).toBe(host);
    expect(ipcPath(home.replaceAll('\\', '/'), 'host')).toBe(host);
    expect(ipcPath(`${home}\\`, 'host')).toBe(host);
  });

  it('renames every pipe of the home once its nonce is rotated', () => {
    const { home } = fixture();
    const host = ipcPath(home, 'host');
    const install = ipcPath(home, 'install');
    rotateIpcNonce(home);
    expect(ipcPath(home, 'host')).not.toBe(host);
    expect(ipcPath(home, 'install')).not.toBe(install);
    expect(readFileSync(join(home, 'ipc-nonce'), 'utf8')).toMatch(/^[0-9a-f]{32}$/);
    expect(readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each(['', '\\'])('refuses a junction as the home (suffix %j)', (suffix) => {
    const { parent, home } = fixture();
    const target = join(parent, 'target');
    mkdirSync(target);
    symlinkSync(target, home, 'junction');
    expect(() => initialisePrivateHome(home + suffix)).toThrow('symbolic link or junction');
    expect(readdirSync(target)).toEqual([]);
  });

  it('names each pipe by an HMAC that a visible name cannot be traced through', () => {
    const { home } = fixture();
    const host = ipcPath(home, 'host');
    const key = readFileSync(join(home, 'ipc-key'), 'utf8');
    const nonce = readFileSync(join(home, 'ipc-nonce'), 'utf8');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(host).toMatch(/^\\\\\.\\pipe\\puddle-[0-9a-f]{48}$/);
    // CLI and daemon compute the same name.
    expect(ipcPath(home, 'host')).toBe(host);
    // Neither secret appears, so the install lock's name says nothing of the daemon's.
    const install = ipcPath(home, 'install');
    for (const name of [host, install]) {
      expect(name).not.toContain(nonce);
      expect(name).not.toContain(key.slice(0, 16));
    }
    expect(install).not.toBe(host);
    expect(ipcPath(fixture().home, 'host')).not.toBe(host);
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
