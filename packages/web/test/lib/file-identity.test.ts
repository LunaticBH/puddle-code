import { describe, expect, it } from 'vitest';
import type { TabRef } from '@puddle/shared';
import { saverKey } from '../../src/features/editor/buffers/save-registry';
import { sameTab, tabKey, type EditorTab } from '../../src/features/editor/tabs/editor-tabs';
import {
  flattenTabs,
  makeLeaf,
  renameBufferTabs,
  retargetFollowingTabs,
  sameFollowingTarget,
} from '../../src/features/workspace/layout/layout-tree';
import { fileIdentity, sameFileIdentity } from '../../src/lib/host-path';
import { draftKey } from '../../src/lib/persistence/drafts';

/**
 * One file reached by two spellings under a Windows root is one tab and one
 * buffer (F26); every other identity stays exact, so POSIX keys are unchanged.
 * `bufferKey` (monaco-bound) and the cross-window `peerKey` share this formula.
 */

const external = (path: string, root: string, kind: 'external' | 'commit' = 'external') =>
  ({ kind, session: 's1', path, root }) satisfies EditorTab;

describe('fileIdentity', () => {
  it('folds case and separators under a Windows root', () => {
    expect(fileIdentity('Src\\App.tsx', 'C:\\Users\\A\\Repo\\')).toEqual({
      path: 'src/app.tsx',
      root: 'c:\\users\\a\\repo',
    });
    expect(fileIdentity('src/app.tsx', 'c:/users/a/repo')).toEqual(
      fileIdentity('SRC/App.tsx', 'C:\\Users\\a\\Repo'),
    );
    expect(fileIdentity('a.txt', '\\\\Files\\Team')).toEqual({
      path: 'a.txt',
      root: '\\\\files\\team\\',
    });
  });

  it('keeps POSIX roots and worktree files exactly as given', () => {
    expect(fileIdentity('Src/App.tsx', '/Users/A/Repo/')).toEqual({
      path: 'Src/App.tsx',
      root: '/Users/A/Repo/',
    });
    expect(fileIdentity('Src\\App.tsx')).toEqual({ path: 'Src\\App.tsx' });
    expect(sameFileIdentity({ path: 'a.md' }, { path: 'A.md' })).toBe(false);
    expect(sameFileIdentity({ path: 'a.md', root: '/r' }, { path: 'A.md', root: '/r' })).toBe(
      false,
    );
    expect(sameFileIdentity({ path: 'a.md', root: '/r' }, { path: 'a.md', root: '/R' })).toBe(
      false,
    );
    expect(sameFileIdentity({ path: 'a.md' }, { path: 'a.md', root: '' })).toBe(false);
  });
});

describe('tab and buffer keys', () => {
  it('give one key to two spellings of a file under a Windows root', () => {
    const a = external('docs/Notes.md', 'C:\\Users\\a\\repo');
    const b = external('DOCS\\notes.md', 'c:/users/A/Repo/');
    expect(tabKey(a)).toBe(tabKey(b));
    expect(sameTab(a, b)).toBe(true);
    expect(draftKey(a.session, a.path, a.root)).toBe(draftKey(b.session, b.path, b.root));
    expect(saverKey(a.session, a.path, a.root)).toBe(saverKey(b.session, b.path, b.root));
    expect(tabKey(external('a.md', 'C:\\repo')) === tabKey(external('a.md', 'C:\\repo2'))).toBe(
      false,
    );
  });

  it("keep a commit's git path exact, and every POSIX key byte for byte", () => {
    expect(tabKey(external('A.md', 'C:\\repo', 'commit'))).toBe('commit:s1::C:\\repo:A.md');
    expect(tabKey(external('Docs/A.md', '/home/a/repo'))).toBe(
      'external:s1::/home/a/repo:Docs/A.md',
    );
    expect(tabKey({ session: 's1', path: 'Src/App.tsx' })).toBe('file:s1:::Src/App.tsx');
    expect(draftKey('s1', 'Src/App.tsx')).toBe('s1:Src%2FApp.tsx');
    expect(draftKey('s1', 'A.md', '/r')).toBe('s1:A.md:%2Fr');
    expect(saverKey('s1', 'A.md', '/r')).toBe('s1:A.md:%2Fr');
  });
});

describe('layout identity', () => {
  const ref = (tab: EditorTab): TabRef => ({ type: 'editor', tab });

  it('retargets every view of a file renamed under another spelling of its root', () => {
    const open = external('docs/notes.md', 'C:\\Users\\a\\repo');
    const tree = makeLeaf([ref(open), ref({ ...open, kind: 'external', view: 'linked' })]);
    const next = renameBufferTabs(
      tree,
      external('Docs/Notes.md', 'c:\\users\\a\\repo'),
      'docs/renamed.md',
    );
    expect(flattenTabs(next).map((t) => (t.type === 'editor' ? t.tab.path : ''))).toEqual([
      'docs/renamed.md',
      'docs/renamed.md',
    ]);
  });

  it('leaves a following slot alone when it already shows the file in another spelling', () => {
    const slot = { ...external('README.md', 'C:\\repo'), view: 'linked' as const };
    const tree = makeLeaf([ref(slot)]);
    expect(sameFollowingTarget(slot, external('readme.md', 'c:/REPO'))).toBe(true);
    expect(retargetFollowingTabs(tree, ref(external('readme.md', 'c:/REPO')))).toBe(tree);
    // A different file under the same root still retargets.
    expect(retargetFollowingTabs(tree, ref(external('other.md', 'C:\\repo')))).not.toBe(tree);
    expect(
      sameFollowingTarget(
        { session: 's1', path: 'README.md', view: 'linked' },
        { session: 's1', path: 'readme.md' },
      ),
    ).toBe(false);
  });
});
