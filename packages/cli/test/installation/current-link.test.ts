import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readCurrentVersion,
  versionFromLinkTarget,
} from '../../src/lib/installation/current-link.js';

describe('the bin/current link', () => {
  it('reads install.sh symlink targets exactly as before', () => {
    expect(versionFromLinkTarget('versions/0.3.14', 'linux')).toBe('0.3.14');
    expect(versionFromLinkTarget('/home/a/.puddle/bin/versions/0.3.14', 'darwin')).toBe('0.3.14');
    // POSIX targets are not reinterpreted: these never named a version.
    expect(versionFromLinkTarget('versions/0.3.14/', 'linux')).toBeUndefined();
    expect(versionFromLinkTarget('versions\\0.3.14', 'linux')).toBeUndefined();
    expect(versionFromLinkTarget('elsewhere', 'linux')).toBeUndefined();
  });

  it('normalises Windows junction targets: backslashes and a trailing separator', () => {
    const target = 'C:\\Users\\A B\\.puddle\\bin\\versions\\0.3.14';
    expect(versionFromLinkTarget(target, 'win32')).toBe('0.3.14');
    expect(versionFromLinkTarget(`${target}\\`, 'win32')).toBe('0.3.14');
    expect(versionFromLinkTarget(`\\\\?\\${target}\\\\`, 'win32')).toBe('0.3.14');
    expect(versionFromLinkTarget('C:\\Users\\a\\.puddle\\bin\\other', 'win32')).toBeUndefined();
  });

  it('reads the link this platform’s installer writes, and nothing when it is absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-current-link-'));
    expect(readCurrentVersion(home)).toBeUndefined();
    mkdirSync(join(home, 'bin', 'versions', '1.2.3'), { recursive: true });
    if (process.platform === 'win32') {
      symlinkSync(join(home, 'bin', 'versions', '1.2.3'), join(home, 'bin', 'current'), 'junction');
    } else {
      symlinkSync('versions/1.2.3', join(home, 'bin', 'current'));
    }
    expect(readCurrentVersion(home)).toBe('1.2.3');
  });
});
