/**
 * Pure-logic tests for the uncommitted-changes tree builder (SPEC §8).
 */
import { describe, expect, it } from 'vitest';
import type { DiffEntry } from '@puddle/shared';
import {
  buildFileTree,
  flatFileList,
  treeEntries,
  type TreeDirNode,
} from '../../src/features/changes/file-tree';

const file = (path: string, status: DiffEntry['status'] = 'modified'): DiffEntry => ({
  path,
  status,
  old_path: null,
});

describe('buildFileTree', () => {
  it('nests files under their directories, directories first then files', () => {
    const tree = buildFileTree([file('src/a.ts'), file('README.md'), file('src/b.ts')]);
    // dir `src` sorts before the top-level file `README.md`.
    expect(tree.map((n) => n.name)).toEqual(['src', 'README.md']);
    const src = tree[0] as TreeDirNode;
    expect(src.type).toBe('dir');
    expect(src.children.map((n) => n.name)).toEqual(['a.ts', 'b.ts']);
  });

  it('compacts single-child directory chains (VS Code style)', () => {
    const tree = buildFileTree([file('a/b/c/deep.ts')]);
    expect(tree).toHaveLength(1);
    const node = tree[0] as TreeDirNode;
    expect(node.type).toBe('dir');
    expect(node.name).toBe('a/b/c');
    expect(node.path).toBe('a/b/c');
    expect(node.children.map((n) => n.name)).toEqual(['deep.ts']);
  });

  it('does not compact a directory that also holds files', () => {
    const tree = buildFileTree([file('a/x.ts'), file('a/b/y.ts')]);
    const a = tree[0] as TreeDirNode;
    expect(a.name).toBe('a');
    // `a` holds both sub-dir `b` and file `x.ts`, so it stays its own row.
    expect(a.children.map((n) => n.name)).toEqual(['b', 'x.ts']);
  });

  it('carries the full path and diff entry on file nodes', () => {
    const tree = buildFileTree([file('src/a.ts', 'added')]);
    const src = tree[0] as TreeDirNode;
    const leaf = src.children[0]!;
    expect(leaf.type).toBe('file');
    if (leaf.type === 'file') {
      expect(leaf.path).toBe('src/a.ts');
      expect(leaf.entry.status).toBe('added');
    }
  });

  it('returns every descendant entry for a directory action', () => {
    const tree = buildFileTree([file('src/a.ts'), file('src/nested/b.ts'), file('other.ts')]);
    const src = tree[0] as TreeDirNode;
    expect(treeEntries(src).map((entry) => entry.path)).toEqual(['src/nested/b.ts', 'src/a.ts']);
  });
});

describe('flatFileList', () => {
  it('returns files sorted by full path with basenames as names', () => {
    const list = flatFileList([file('src/z.ts'), file('a.ts'), file('src/a.ts')]);
    expect(list.map((n) => n.path)).toEqual(['a.ts', 'src/a.ts', 'src/z.ts']);
    expect(list[1]!.name).toBe('a.ts');
  });
});
