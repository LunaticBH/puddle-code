import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hostBasename,
  hostDirname,
  hostJoin,
  hostPathStyle,
  hostSeparator,
  isAbsoluteHostPath,
  isInsideHostPath,
  normaliseHostPath,
  toRootRelative,
  windowsNameProblem,
} from '../src/index.js';

const POSIX_PATHS = [
  '',
  '.',
  '..',
  '/',
  '//',
  '///',
  '/a',
  '//a',
  '//a/b',
  '/a/',
  '/a//b',
  '/a/b/',
  '/a/b//',
  '/a/./b',
  '/a/../b',
  '/../a',
  '/a/b/../../..',
  'a',
  'a/',
  'a/b',
  'a/../..',
  './a',
  '../a/b',
  'a/./',
  '.hidden',
  '/home/user/.config/',
  '/repo/C:/x',
  'C:relative',
  'c\\back\\slash',
  '/tmp/name with spaces/x',
  '/ünï/çødé',
];

/** Deterministic pseudo-random POSIX paths over the characters that matter. */
function fuzzPosix(count: number): string[] {
  const alphabet = ['/', '/', '.', '..', 'a', 'b', '\\', ' '];
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed;
  };
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let path = '';
    const length = next() % 9;
    for (let j = 0; j < length; j++) path += alphabet[next() % alphabet.length];
    // Exclude the few generated strings that are Windows-style by design.
    if (hostPathStyle(path) === 'posix') out.push(path);
  }
  return out;
}

describe('host path style', () => {
  it.each([
    ['C:\\Users\\a', 'win32'],
    ['c:/Users/a', 'win32'],
    ['C:', 'win32'],
    ['z:\\', 'win32'],
    ['\\\\server\\share\\x', 'win32'],
    ['\\\\?\\C:\\very\\long', 'win32'],
    ['\\\\.\\pipe\\x', 'win32'],
    ['/home/a', 'posix'],
    ['//server/share', 'posix'],
    ['C:relative', 'posix'],
    ['CC:\\x', 'posix'],
    ['relative\\path', 'posix'],
    ['', 'posix'],
    ['1:\\x', 'posix'],
  ] as const)('%s is %s', (path, style) => {
    expect(hostPathStyle(path)).toBe(style);
  });

  it('names the separator for each style', () => {
    expect(hostSeparator('win32')).toBe('\\');
    expect(hostSeparator('posix')).toBe('/');
  });
});

describe('POSIX host paths match path.posix exactly', () => {
  const paths = [...POSIX_PATHS, ...fuzzPosix(400)];

  it('normalise, dirname, basename and isAbsolute', () => {
    for (const path of paths) {
      expect(normaliseHostPath(path), path).toBe(posix.normalize(path));
      expect(hostDirname(path), path).toBe(posix.dirname(path));
      expect(hostBasename(path), path).toBe(posix.basename(path));
      expect(isAbsoluteHostPath(path), path).toBe(posix.isAbsolute(path));
    }
  });

  it('join', () => {
    const bases = ['/', '/repo', '/repo/', '/a/b/..', 'rel', ''];
    const relatives = ['', 'x', 'x/y', 'x/../..', '../../../z', './x/', '/abs', 'a\\b'];
    for (const base of bases) {
      for (const relative of relatives) {
        expect(hostJoin(base, relative), `${base} + ${relative}`).toBe(posix.join(base, relative));
      }
    }
    for (const path of paths) {
      if (hostPathStyle(path) === 'posix')
        expect(hostJoin('/r', path)).toBe(posix.join('/r', path));
    }
  });

  it('containment and root-relative paths agree with path.posix.relative', () => {
    const roots = ['/', '/repo', '/repo/', '/repo/./sub/..', '/a/b'];
    const candidates = [
      '/',
      '/repo',
      '/repo/',
      '/repo/x',
      '/repo/x/y/',
      '/repo/../repo/x',
      '/repo-copy',
      '/repo-copy/x',
      '/re',
      '/a/b/c',
      '/a',
      '//repo//x',
    ];
    for (const root of roots) {
      for (const candidate of candidates) {
        const relative = posix.relative(root, candidate);
        const inside = relative === '' || (relative !== '..' && !relative.startsWith('../'));
        expect(isInsideHostPath(root, candidate), `${root} ⊇ ${candidate}`).toBe(inside);
        expect(toRootRelative(root, candidate), `${root} → ${candidate}`).toBe(
          inside ? relative : null,
        );
      }
    }
  });

  it('never treats relative paths as inside', () => {
    expect(isInsideHostPath('/repo', 'repo/x')).toBe(false);
    expect(isInsideHostPath('repo', 'repo/x')).toBe(false);
    expect(toRootRelative('repo', 'repo/x')).toBeNull();
  });
});

describe('Windows host paths', () => {
  const absolute = [
    'C:\\',
    'C:\\Users',
    'C:\\Users\\',
    'C:\\Users\\a\\repo',
    'C:\\Users\\a\\repo\\',
    'C:/Users/a/repo',
    'C:\\a\\.\\b\\..\\c',
    'C:\\..\\..\\a',
    'C:\\a\\\\b',
    'd:\\lower\\drive',
    '\\\\server\\share',
    '\\\\server\\share\\',
    '\\\\server\\share\\dir\\file.txt',
    '\\\\server\\share\\..\\..\\x',
    '\\\\?\\C:\\very\\long\\path',
  ];

  it('agree with path.win32 on normalisation, apart from the upper-case drive', () => {
    for (const path of absolute) {
      const expected = win32.normalize(path).replace(/^[a-z]:/, (drive) => drive.toUpperCase());
      expect(normaliseHostPath(path), path).toBe(expected);
      expect(isAbsoluteHostPath(path), path).toBe(win32.isAbsolute(path));
    }
    expect(normaliseHostPath('C:')).toBe('C:.');
  });

  it('agree with path.win32 on basename and normalised dirname', () => {
    for (const path of absolute) {
      expect(hostBasename(path), path).toBe(win32.basename(path));
      const canonical = win32.normalize(path);
      expect(hostDirname(canonical), path).toBe(win32.dirname(canonical));
    }
    expect(hostDirname('C:/Users/a/repo')).toBe('C:\\Users\\a');
    expect(hostDirname('C:\\a\\\\b')).toBe('C:\\a');
    expect(hostDirname('C:\\')).toBe('C:\\');
    expect(hostDirname('\\\\server\\share\\x')).toBe('\\\\server\\share\\');
    expect(hostBasename('C:\\')).toBe('');
  });

  it('reports a bare drive as relative', () => {
    expect(isAbsoluteHostPath('C:')).toBe(false);
    expect(isAbsoluteHostPath('C:\\')).toBe(true);
    expect(isAbsoluteHostPath('\\\\server\\share')).toBe(true);
  });

  it('joins root-relative paths with backslashes', () => {
    expect(hostJoin('C:\\repo', 'src/index.ts')).toBe('C:\\repo\\src\\index.ts');
    expect(hostJoin('C:\\repo\\', 'src\\index.ts')).toBe('C:\\repo\\src\\index.ts');
    expect(hostJoin('C:\\repo', '')).toBe('C:\\repo');
    expect(hostJoin('C:\\', 'x')).toBe('C:\\x');
    expect(hostJoin('c:/repo', 'a/../b')).toBe('C:\\repo\\b');
    expect(hostJoin('C:\\repo', '../../..')).toBe('C:\\');
    expect(hostJoin('\\\\server\\share', 'dir/f')).toBe('\\\\server\\share\\dir\\f');
    for (const [base, relative] of [
      ['C:\\repo', 'src/index.ts'],
      ['C:\\repo\\sub\\', '../x/./y'],
      ['\\\\server\\share\\d', 'e/f'],
    ] as const) {
      expect(hostJoin(base, relative)).toBe(win32.join(base, relative));
    }
  });

  it('compares containment case-insensitively across separators', () => {
    expect(isInsideHostPath('C:\\Repo', 'c:/repo/src/x.ts')).toBe(true);
    expect(isInsideHostPath('C:\\Repo\\', 'C:\\REPO')).toBe(true);
    expect(isInsideHostPath('C:\\', 'C:\\anything\\below')).toBe(true);
    expect(isInsideHostPath('C:\\repo', 'C:\\repo-copy\\x')).toBe(false);
    expect(isInsideHostPath('C:\\repo', 'C:\\repo\\..\\other')).toBe(false);
    expect(isInsideHostPath('C:\\repo', 'D:\\repo\\x')).toBe(false);
    expect(isInsideHostPath('\\\\server\\share', '\\\\SERVER\\Share\\x')).toBe(true);
    expect(isInsideHostPath('\\\\server\\share', '\\\\server\\other\\x')).toBe(false);
    expect(isInsideHostPath('C:\\repo', '/repo/x')).toBe(false);
    expect(isInsideHostPath('/repo', 'C:\\repo')).toBe(false);
    expect(isInsideHostPath('C:', 'C:\\x')).toBe(false);
  });

  it('produces /-separated root-relative paths in the candidate spelling', () => {
    expect(toRootRelative('C:\\Repo', 'c:\\repo\\Src\\Index.ts')).toBe('Src/Index.ts');
    expect(toRootRelative('C:\\repo', 'C:\\repo')).toBe('');
    expect(toRootRelative('C:\\repo\\', 'C:/repo/a/./b/')).toBe('a/b');
    expect(toRootRelative('C:\\', 'C:\\Users\\a')).toBe('Users/a');
    expect(toRootRelative('C:\\repo', 'C:\\repo-copy')).toBeNull();
    expect(toRootRelative('\\\\server\\share\\d', '\\\\server\\share\\d\\e\\f')).toBe('e/f');
  });
});

describe('names Windows cannot store', () => {
  it('rejects reserved device names with or without an extension', () => {
    for (const name of ['CON', 'con', 'Prn', 'aux.md', 'NUL', 'nul.tar.gz', 'COM1', 'lpt9.txt']) {
      expect(windowsNameProblem(name), name).toMatch(/reserved device name/);
    }
    expect(windowsNameProblem('COM¹')).toMatch(/reserved device name/);
  });

  it('rejects forbidden characters, stream names and trailing dots or spaces', () => {
    for (const name of ['a<b', 'a>b', 'f.txt:hidden', 'D:foo', 'say"hi"', 'a|b', 'why?', 'a*']) {
      expect(windowsNameProblem(name), name).toMatch(/cannot contain/);
    }
    expect(windowsNameProblem('tab\there')).toMatch(/cannot contain/);
    for (const name of ['trailing.', 'trailing ', 'dots...']) {
      expect(windowsNameProblem(name), name).toMatch(/dot or a space/);
    }
  });

  it('accepts ordinary names, including ones that merely start like a device', () => {
    for (const name of ['.', '..', 'console.log', 'nul-device', 'COMET', 'com10', '.env']) {
      expect(windowsNameProblem(name), name).toBeNull();
    }
    expect(windowsNameProblem('a b.txt')).toBeNull();
    expect(windowsNameProblem('[ab].txt')).toBeNull();
  });
});
