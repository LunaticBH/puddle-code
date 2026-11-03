import { beforeEach, describe, expect, it } from 'vitest';
import { ancestorDirs } from '../../../src/features/explorer/explorer-paths';
import {
  clearPendingReveal,
  onReveal,
  requestReveal,
} from '../../../src/lib/navigation/reveal-in-tree';

describe('ancestorDirs', () => {
  it('lists every directory to expand, outermost first', () => {
    expect(ancestorDirs('packages/web/src/app.tsx')).toEqual([
      'packages',
      'packages/web',
      'packages/web/src',
    ]);
  });

  it('is empty for a root-level path — the root is always expanded', () => {
    expect(ancestorDirs('README.md')).toEqual([]);
  });

  it('treats a revealed DIRECTORY like a leaf: its own name is not an ancestor', () => {
    expect(ancestorDirs('packages/web')).toEqual(['packages']);
  });
});

describe('reveal latch', () => {
  beforeEach(() => clearPendingReveal());

  it('delivers to a tree already listening', () => {
    const seen: string[] = [];
    const off = onReveal((r) => seen.push(r.path));
    requestReveal({ path: 'a/b.ts' });
    expect(seen).toEqual(['a/b.ts']);
    off();
  });

  it('holds a request made while no tree was mounted, then delivers on subscribe', () => {
    // The left sidebar shows one navigator at a time: a path clicked in Search
    // is asking a Files tree that does not exist yet.
    requestReveal({ path: 'a/b.ts', root: '/tmp/x' });
    const seen: { path: string; root?: string | undefined; expandTarget?: boolean }[] = [];
    const off = onReveal((r) => seen.push(r));
    expect(seen).toEqual([{ path: 'a/b.ts', root: '/tmp/x' }]);
    off();
  });

  it('carries a directory-expansion request to Files', () => {
    const seen: { path: string; expandTarget?: boolean }[] = [];
    const off = onReveal((r) => seen.push(r));
    requestReveal({ path: 'packages/web', expandTarget: true });
    expect(seen).toEqual([{ path: 'packages/web', expandTarget: true }]);
    off();
  });

  it('carries the effective directory so another worktree cannot consume it', () => {
    const seen: { path: string; directory?: string }[] = [];
    const off = onReveal((r) => seen.push(r));
    requestReveal({ path: 'README.md', directory: '/worktrees/feature' });
    expect(seen).toEqual([{ path: 'README.md', directory: '/worktrees/feature' }]);
    off();
  });

  it("can request the receiving tree's inline rename", () => {
    const seen: { path: string; renameTarget?: boolean }[] = [];
    const off = onReveal((r) => seen.push(r));
    requestReveal({ path: 'src/app.ts', renameTarget: true });
    expect(seen).toEqual([{ path: 'src/app.ts', renameTarget: true }]);
    off();
  });

  it('fires once: a tree that consumed the latch does not see it again', () => {
    requestReveal({ path: 'a/b.ts' });
    const first: string[] = [];
    const offFirst = onReveal((r) => {
      first.push(r.path);
      clearPendingReveal();
    });
    offFirst();
    const second: string[] = [];
    const offSecond = onReveal((r) => second.push(r.path));
    expect(first).toEqual(['a/b.ts']);
    expect(second).toEqual([]);
    offSecond();
  });
});
