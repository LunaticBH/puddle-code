import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const INSTALLER = join(ROOT, 'scripts', 'install.sh');

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'puddle-install-script-'));
  const home = join(temp, 'home');
  const puddleHome = join(home, '.puddle');
  const staged = join(temp, 'stage', 'puddled-v1.2.3');
  const tarball = join(temp, 'puddled-v1.2.3-linux-x64.tar.gz');
  mkdirSync(staged, { recursive: true });
  mkdirSync(home, { recursive: true });
  const stagedBinary = join(staged, 'puddled');
  writeFileSync(stagedBinary, '#!/bin/sh\nprintf "puddled 1.2.3\\n"\n');
  chmodSync(stagedBinary, 0o755);
  execFileSync('tar', ['-czf', tarball, '-C', join(temp, 'stage'), 'puddled-v1.2.3']);

  const install = () =>
    execFileSync(
      'sh',
      // Pin the caller's ordinary umask: fresh installs must not depend on it.
      [
        '-c',
        'umask 022; exec sh "$@"',
        'install-test',
        INSTALLER,
        '--version',
        '1.2.3',
        '--tarball',
        tarball,
        '--no-supervisor',
      ],
      { env: { ...process.env, HOME: home, PUDDLE_HOME: puddleHome }, encoding: 'utf8' },
    );
  return { temp, puddleHome, install };
}

// install.sh runs only on POSIX hosts: Windows installs with windows-install.ts
// (covered by windows-install.test.ts).
describe.skipIf(process.platform === 'win32')('install.sh tree validation', () => {
  it('creates a private home with an ordinary caller umask', () => {
    const { puddleHome, install } = fixture();
    install();
    expect(statSync(puddleHome).mode & 0o777).toBe(0o700);
  });

  it('migrates legacy home permissions on reinstall without changing existing data', () => {
    const { puddleHome, install } = fixture();
    install();
    const data = join(puddleHome, 'puddle.db');
    writeFileSync(data, 'existing session data');
    chmodSync(data, 0o640);
    chmodSync(puddleHome, 0o755);
    expect(install()).toContain('version 1.2.3 already installed');
    expect(statSync(puddleHome).mode & 0o777).toBe(0o700);
    expect(readFileSync(data, 'utf8')).toBe('existing session data');
    expect(statSync(data).mode & 0o777).toBe(0o640);
  });

  it('refuses a symlinked home without changing its target', () => {
    const { temp, puddleHome, install } = fixture();
    const target = join(temp, 'target');
    mkdirSync(target);
    chmodSync(target, 0o755);
    symlinkSync(target, puddleHome);
    expect(install).toThrow('must not be a symlink');
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  it('refuses a home writable by other users', () => {
    const { puddleHome, install } = fixture();
    mkdirSync(puddleHome);
    chmodSync(puddleHome, 0o777);
    expect(install).toThrow('must not be writable by other users');
    expect(statSync(puddleHome).mode & 0o777).toBe(0o777);
  });

  it('reinstalls an existing tree that no longer passes its smoke test', () => {
    const { puddleHome, install } = fixture();
    install();
    expect(readFileSync(join(puddleHome, 'supervisor'), 'utf8')).toBe('none\n');

    const installed = join(puddleHome, 'bin', 'versions', '1.2.3', 'puddled');
    writeFileSync(installed, '#!/bin/sh\nexit 1\n');
    chmodSync(installed, 0o755);
    const output = install();

    expect(output).toContain('existing version 1.2.3 failed validation — reinstalling');
    expect(execFileSync(installed, ['--version'], { encoding: 'utf8' })).toBe('puddled 1.2.3\n');
  });
});
