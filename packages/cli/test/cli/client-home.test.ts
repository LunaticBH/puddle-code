import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordDesktopInstallation } from '../../src/lib/installation/component-versions.js';
import { prepareClientHome } from '../../src/lib/paths.js';
import { writeCockpitRecord } from '../../src/lib/registry.js';

/**
 * The first write into a new client home (docs/windows.md, decision 2): on
 * Windows the home must be private before anything is created in it, or a
 * home outside the profile inherits its drive root's ACL meanwhile.
 */
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
};

describe('preparing the client home', () => {
  it('leaves the mkdir to POSIX callers', () => {
    const home = join(scratch('puddle-client-home-'), '.puddle');
    prepareClientHome(home, 'linux');
    expect(existsSync(home)).toBe(false);
  });

  describe.skipIf(process.platform !== 'win32')('on Windows, outside the profile', () => {
    const saved = { profile: process.env.USERPROFILE, home: process.env.PUDDLE_HOME };
    let parent: string;
    let home: string;
    const icacls = (...args: string[]) =>
      execFileSync(join(process.env.SystemRoot!, 'System32', 'icacls.exe'), args, {
        encoding: 'utf8',
        windowsHide: true,
      });
    beforeEach(() => {
      // tmpdir() is inside the profile, so another folder plays the profile here.
      process.env.USERPROFILE = scratch('puddle-other-profile-');
      // As under C:\ or D:\: every new folder inherits Authenticated Users' Modify.
      parent = scratch('puddle-shared-drive-');
      icacls(parent, '/grant', '*S-1-5-11:(OI)(CI)M');
      home = join(parent, '.puddle');
      process.env.PUDDLE_HOME = home;
    });
    afterEach(() => {
      process.env.USERPROFILE = saved.profile;
      if (saved.home === undefined) delete process.env.PUDDLE_HOME;
      else process.env.PUDDLE_HOME = saved.home;
    });
    const isPrivate = () => {
      const acl = icacls(home);
      return !acl.includes('(I)') && !/\(M\)/.test(acl);
    };

    it('creates a new home with its protected DACL', () => {
      prepareClientHome();
      expect(isPrivate()).toBe(true);
    });

    it('before a cockpit writes its record into a new home', () => {
      writeCockpitRecord({
        target: 'local',
        pid: process.pid,
        status: 'starting',
        startedAt: new Date().toISOString(),
        cliVersion: 'test',
      });
      expect(isPrivate()).toBe(true);
    });

    it('before the desktop records its installation in a new home', () => {
      recordDesktopInstallation({ path: 'C:\\Puddle\\Puddle.exe', version: '1.2.3' });
      expect(existsSync(join(home, 'desktop-install.json'))).toBe(true);
      expect(isPrivate()).toBe(true);
    });
  });
});
