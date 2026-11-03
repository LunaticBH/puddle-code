import { describe, expect, it } from 'vitest';
import type { TreeResponse } from '@puddle/shared';
import {
  basename,
  buildVisibleRows,
  decodeDragPaths,
  dirOf,
  encodeDragPaths,
  isInside,
  joinPath,
  joinAbsolutePath,
  pruneNested,
  rangeBetween,
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
