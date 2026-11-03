import { describe, expect, it } from 'vitest';
import type { TreeResponse } from '@puddle/shared';
import {
  basename,
  buildVisibleRows,
  copyablePath,
  decodeDragPaths,
  dirOf,
  encodeDragPaths,
  isInside,
  joinPath,
  joinAbsolutePath,
  parentDir,
  pruneNested,
  rangeBetween,
  relativePathWithinAbsoluteRoot,
} from '../../src/features/explorer/explorer-paths';

describe('path helpers', () => {
  it('basename / dirOf / joinPath', () => {
    expect(basename('a/b/c.txt')).toBe('c.txt');
    expect(basename('top')).toBe('top');
    expect(dirOf('a/b/c')).toBe('a/b');
    expect(dirOf('top')).toBe('');
    expect(joinPath('', 'x')).toBe('x');
    expect(joinPath('a/b', 'x')).toBe('a/b/x');
  });

  it('joins absolute roots without duplicating their trailing slash', () => {
    expect(joinAbsolutePath('/tmp/root/', 'nested/file.ts')).toBe('/tmp/root/nested/file.ts');
    expect(joinAbsolutePath('/', 'README.md')).toBe('/README.md');
    expect(joinAbsolutePath('/tmp/root', '')).toBe('/tmp/root');
  });

  it('joins a Windows root with native separators throughout', () => {
    expect(joinAbsolutePath('C:\\repo', 'src/a.ts')).toBe('C:\\repo\\src\\a.ts');
    expect(joinAbsolutePath('C:\\repo\\', 'src/a.ts')).toBe('C:\\repo\\src\\a.ts');
    expect(joinAbsolutePath('C:\\', 'README.md')).toBe('C:\\README.md');
    expect(joinAbsolutePath('\\\\server\\share', 'docs/x.md')).toBe(
      '\\\\server\\share\\docs\\x.md',
    );
    expect(joinAbsolutePath('C:\\repo', '')).toBe('C:\\repo');
  });

  it('parentDir walks POSIX paths up to `/`', () => {
    expect(parentDir('/home/alice/repo')).toBe('/home/alice');
    expect(parentDir('/home/alice/repo/')).toBe('/home/alice');
    expect(parentDir('/home')).toBe('/');
    expect(parentDir('/')).toBe('/');
  });

  it('parentDir stops at a Windows drive root or UNC share', () => {
    expect(parentDir('C:\\Users\\alice\\repo')).toBe('C:\\Users\\alice');
    expect(parentDir('C:\\Users')).toBe('C:\\');
    expect(parentDir('C:\\')).toBe('C:\\');
    expect(parentDir('C:/Users/alice')).toBe('C:\\Users');
    expect(parentDir('\\\\server\\share\\dir')).toBe('\\\\server\\share\\');
    expect(parentDir('\\\\server\\share\\')).toBe('\\\\server\\share\\');
  });

  it('copyablePath gives native absolute paths and `/` relative ones', () => {
    expect(copyablePath('/home/a/repo', 'src/a.ts', false)).toBe('/home/a/repo/src/a.ts');
    // POSIX keeps its historical root-row form.
    expect(copyablePath('/home/a/repo', '', false)).toBe('/home/a/repo/');
    expect(copyablePath('C:\\repo', 'src/a.ts', false)).toBe('C:\\repo\\src\\a.ts');
    expect(copyablePath('C:\\repo', '', false)).toBe('C:\\repo');
    expect(copyablePath('C:\\repo', 'src/a.ts', true)).toBe('src/a.ts');
  });

  it('relativePathWithinAbsoluteRoot accepts Windows paths case-insensitively', () => {
    expect(relativePathWithinAbsoluteRoot('C:\\repo', 'c:\\Repo\\src\\a.ts')).toBe('src/a.ts');
    expect(relativePathWithinAbsoluteRoot('C:\\', 'C:\\Users\\a')).toBe('Users/a');
    expect(relativePathWithinAbsoluteRoot('C:\\repo', 'C:\\repo')).toBe('');
    expect(relativePathWithinAbsoluteRoot('C:\\repo', 'C:\\repo-copy\\a.ts')).toBeNull();
    expect(relativePathWithinAbsoluteRoot('/repo', '/Repo/a.ts')).toBeNull();
  });

  it('isInside guards a folder against moving into its own subtree', () => {
    expect(isInside('a/b', 'a')).toBe(true);
    expect(isInside('a', 'a')).toBe(true);
    expect(isInside('ab/c', 'a')).toBe(false); // prefix but not a path boundary
  });

  it('pruneNested drops paths covered by a selected ancestor', () => {
    expect(pruneNested(['a', 'a/b', 'a/b/c', 'd'])).toEqual(['a', 'd']);
    expect(pruneNested(['a/b', 'ab/c', 'a'])).toEqual(['ab/c', 'a']); // prefix ≠ ancestor
    expect(pruneNested([''])).toEqual(['']); // the root is its own dirOf — never self-pruned
    expect(pruneNested(['', 'a', 'a/b'])).toEqual(['']); // …but covers everything else
  });

  it('drag payload round-trips and rejects foreign data', () => {
    expect(decodeDragPaths(encodeDragPaths(['a', 'b/c']))).toEqual(['a', 'b/c']);
    expect(decodeDragPaths('')).toEqual([]);
    expect(decodeDragPaths('not json')).toEqual([]);
    expect(decodeDragPaths('{"x":1}')).toEqual([]);
    expect(decodeDragPaths('[1,"a"]')).toEqual(['a']); // non-strings dropped
  });
});

const tree = (path: string, names: [string, 'file' | 'dir'][]): TreeResponse => ({
  path,
  entries: names.map(([name, type]) => ({ name, type, size: type === 'file' ? 1 : null })),
});

describe('buildVisibleRows', () => {
  const store = new Map<string, TreeResponse>([
    [
      '',
      tree('', [
        ['src', 'dir'],
        ['README.md', 'file'],
      ]),
    ],
    ['src', tree('src', [['app.ts', 'file']])],
  ]);
  const read = (dir: string) => store.get(dir);

  it('lists only expanded directories in order', () => {
    const collapsed = buildVisibleRows(read, new Set());
    expect(collapsed.map((r) => r.path)).toEqual(['src', 'README.md']);

    const expanded = buildVisibleRows(read, new Set(['src']));
    expect(expanded.map((r) => r.path)).toEqual(['src', 'src/app.ts', 'README.md']);
    expect(expanded.find((r) => r.path === 'src/app.ts')?.depth).toBe(1);
  });

  it('tolerates an expanded-but-unloaded directory', () => {
    const rows = buildVisibleRows((d) => (d === '' ? store.get('') : undefined), new Set(['src']));
    expect(rows.map((r) => r.path)).toEqual(['src', 'README.md']); // no children yet
  });
});

describe('rangeBetween', () => {
  const rows = buildVisibleRows(
    (d) =>
      d === ''
        ? tree('', [
            ['a', 'file'],
            ['b', 'file'],
            ['c', 'file'],
            ['d', 'file'],
          ])
        : undefined,
    new Set(),
  );

  it('returns the inclusive slice regardless of direction', () => {
    expect(rangeBetween(rows, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(rows, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(rows, 'a', 'a')).toEqual(['a']);
  });
});
