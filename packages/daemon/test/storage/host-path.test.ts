import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalHostPath,
  isNativeAbsolute,
  rootBareDrive,
  sameHostPath,
  wireRelative,
} from '../../src/host-path.js';

describe('canonical host paths', () => {
  it('leaves POSIX paths untouched', () => {
    expect(canonicalHostPath('/tmp/../x//y/', 'linux')).toBe('/tmp/../x//y/');
    expect(canonicalHostPath('relative', 'darwin')).toBe('relative');
  });

  it('normalises a Windows path that does not exist, upper-casing its drive', () => {
    expect(canonicalHostPath('c:/no-such-puddle-dir/a/../b/', 'win32')).toBe(
      'C:\\no-such-puddle-dir\\b',
    );
    expect(canonicalHostPath('d:\\no-such-puddle-dir', 'win32')).toMatch(/^D:\\/);
  });

  it.runIf(process.platform === 'win32')(
    'restores real case from the deepest existing ancestor on Windows',
    () => {
      const real = mkdtempSync(join(tmpdir(), 'puddle-Canonical-'));
      try {
        const typed = `${real.toLowerCase().replaceAll('\\', '/')}/not-yet/Child`;
        expect(canonicalHostPath(typed)).toBe(join(real, 'not-yet', 'Child'));
        expect(canonicalHostPath(real.toLowerCase())).toBe(real);
      } finally {
        rmSync(real, { recursive: true, force: true });
      }
    },
  );

  it('compares identities exactly on POSIX and loosely on Windows', () => {
    expect(sameHostPath('/a/B', '/a/b', 'linux')).toBe(false);
    expect(sameHostPath('/a/b', '/a/b', 'linux')).toBe(true);
    expect(sameHostPath('C:\\Repo\\', 'c:/repo', 'win32')).toBe(true);
    expect(sameHostPath('C:\\repo', 'C:\\repo-copy', 'win32')).toBe(false);
  });
});

describe('wire and input spellings', () => {
  it('sends root-relative paths with / on every host', () => {
    expect(wireRelative('src\\a.ts', 'win32')).toBe('src/a.ts');
    expect(wireRelative('src\\a.ts', 'linux')).toBe('src\\a.ts'); // a legal POSIX name
    expect(wireRelative('', 'win32')).toBe('');
  });

  it('accepts only drive and UNC paths as absolute on Windows', () => {
    for (const path of ['C:\\x', 'c:/x', 'C:\\', '\\\\server\\share\\x']) {
      expect(isNativeAbsolute(path, 'win32'), path).toBe(true);
    }
    for (const path of ['/x', '\\x', 'C:', 'C:x', 'x', '']) {
      expect(isNativeAbsolute(path, 'win32'), path).toBe(false);
    }
    expect(isNativeAbsolute('/x', 'linux')).toBe(true);
    expect(isNativeAbsolute('C:\\x', 'linux')).toBe(false);
  });

  it('reads a bare drive as its root on Windows only', () => {
    expect(rootBareDrive('D:', 'win32')).toBe('D:\\');
    expect(rootBareDrive('D:\\x', 'win32')).toBe('D:\\x');
    expect(rootBareDrive('D:', 'linux')).toBe('D:');
  });
});
