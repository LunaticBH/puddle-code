import { describe, expect, it } from 'vitest';
import {
  hostPathKey,
  hostStyleForPlatform,
  isHostPathish,
  isHostRoot,
  leadingTilde,
  nativeWindowsPath,
  sameHostPath,
  typedRootRelativePath,
} from '../../src/lib/host-path';

describe('hostStyleForPlatform', () => {
  it('reads win32 as Windows and anything else, or nothing, as POSIX', () => {
    expect(hostStyleForPlatform('win32')).toBe('win32');
    expect(hostStyleForPlatform('linux')).toBe('posix');
    expect(hostStyleForPlatform('darwin')).toBe('posix');
    // Daemons older than protocol 25.7 omit the field; none runs on Windows.
    expect(hostStyleForPlatform(undefined)).toBe('posix');
  });
});

describe('isHostPathish', () => {
  it('keeps the POSIX rule: absolute or ~-relative only', () => {
    expect(isHostPathish('/srv/repo', 'posix')).toBe(true);
    expect(isHostPathish('~', 'posix')).toBe(true);
    expect(isHostPathish('~/src', 'posix')).toBe(true);
    expect(isHostPathish('src/repo', 'posix')).toBe(false);
    expect(isHostPathish('C:\\Users\\alice', 'posix')).toBe(false);
    expect(isHostPathish('', 'posix')).toBe(false);
  });

  it('also accepts drive and UNC paths on a Windows host', () => {
    expect(isHostPathish('C:\\Users\\alice', 'win32')).toBe(true);
    expect(isHostPathish('c:/src', 'win32')).toBe(true);
    expect(isHostPathish('D:\\', 'win32')).toBe(true);
    expect(isHostPathish('\\\\server\\share', 'win32')).toBe(true);
    expect(isHostPathish('~\\src', 'win32')).toBe(true);
    expect(isHostPathish('/', 'win32')).toBe(true);
    // A bare drive is relative to that drive's current directory.
    expect(isHostPathish('C:', 'win32')).toBe(false);
    expect(isHostPathish('src\\repo', 'win32')).toBe(false);
  });
});

describe('leadingTilde', () => {
  it('expands ~ before the host separator only', () => {
    expect('~/src'.replace(leadingTilde('posix'), '/home/a')).toBe('/home/a/src');
    expect('~\\src'.replace(leadingTilde('posix'), '/home/a')).toBe('~\\src');
    expect('~\\src'.replace(leadingTilde('win32'), 'C:\\Users\\a')).toBe('C:\\Users\\a\\src');
    expect('~/src'.replace(leadingTilde('win32'), 'C:\\Users\\a')).toBe('C:\\Users\\a/src');
    expect('~'.replace(leadingTilde('win32'), 'C:\\Users\\a')).toBe('C:\\Users\\a');
    expect('~alice'.replace(leadingTilde('win32'), 'C:\\Users\\a')).toBe('~alice');
  });
});

describe('isHostRoot', () => {
  it('is exactly `/` on POSIX', () => {
    expect(isHostRoot('/')).toBe(true);
    expect(isHostRoot('/home')).toBe(false);
    expect(isHostRoot('//')).toBe(false);
  });

  it('recognises drive roots and UNC shares, whatever their separator', () => {
    expect(isHostRoot('C:\\')).toBe(true);
    expect(isHostRoot('c:/')).toBe(true);
    expect(isHostRoot('\\\\server\\share')).toBe(true);
    expect(isHostRoot('\\\\server\\share\\')).toBe(true);
    expect(isHostRoot('C:\\Users')).toBe(false);
    expect(isHostRoot('\\\\server\\share\\dir')).toBe(false);
  });
});

describe('nativeWindowsPath', () => {
  it('canonicalises separators, the drive letter and trailing separators', () => {
    expect(nativeWindowsPath('c:/Users/alice/')).toBe('C:\\Users\\alice');
    expect(nativeWindowsPath('C:\\Users\\alice\\repo')).toBe('C:\\Users\\alice\\repo');
    expect(nativeWindowsPath('C:/')).toBe('C:\\');
    expect(nativeWindowsPath('\\\\server\\share\\dir\\')).toBe('\\\\server\\share\\dir');
  });
});

describe('hostPathKey / sameHostPath', () => {
  it('compares POSIX paths exactly', () => {
    expect(hostPathKey('/home/Alice/repo/')).toBe('/home/Alice/repo/');
    expect(sameHostPath('/home/alice/repo', '/home/alice/repo')).toBe(true);
    expect(sameHostPath('/home/alice/repo', '/home/alice/repo/')).toBe(false);
    expect(sameHostPath('/home/alice/Repo', '/home/alice/repo')).toBe(false);
  });

  it('compares Windows paths as Windows does', () => {
    // git prints `C:/…` where Node prints `C:\…`.
    expect(sameHostPath('C:\\Users\\alice\\wt', 'C:/Users/alice/wt')).toBe(true);
    expect(sameHostPath('C:\\Users\\alice\\wt', 'c:\\users\\ALICE\\wt\\')).toBe(true);
    expect(sameHostPath('C:\\', 'c:/')).toBe(true);
    expect(sameHostPath('C:\\Users\\alice\\wt', 'C:\\Users\\alice\\wt2')).toBe(false);
    expect(sameHostPath('C:\\repo', 'D:\\repo')).toBe(false);
  });

  it('never equates a Windows path with a POSIX one', () => {
    expect(sameHostPath('C:\\repo', '/repo')).toBe(false);
  });
});

describe('typedRootRelativePath', () => {
  it('trims separators and keeps a POSIX backslash as a file-name character', () => {
    expect(typedRootRelativePath('  /docs/notes.md/ ', 'posix')).toBe('docs/notes.md');
    expect(typedRootRelativePath('docs\\notes.md', 'posix')).toBe('docs\\notes.md');
  });

  it('turns a Windows host’s backslashes into the wire form', () => {
    expect(typedRootRelativePath('docs\\notes.md', 'win32')).toBe('docs/notes.md');
    expect(typedRootRelativePath('\\docs\\sub\\', 'win32')).toBe('docs/sub');
  });
});
