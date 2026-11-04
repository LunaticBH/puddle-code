import { describe, expect, it } from 'vitest';
import type { TabRef } from '@puddle/shared';
import { saverKey } from '../../src/features/editor/buffers/save-registry';
import { sameTab, tabKey, type EditorTab } from '../../src/features/editor/tabs/editor-tabs';
import {
  flattenTabs,
  makeLeaf,
  renameBufferTabs,
  retargetFollowingTabs,
} from '../../src/features/workspace/layout/layout-tree';
import { draftKey } from '../../src/lib/persistence/drafts';

/**
 * Tab, buffer, draft and save identity is the exact spelling under every root,
 * Windows ones included. A Windows host answers every path in the case it is
 * stored in (F26), so one file already has one spelling; folding case here
 * would merge two files that a case-sensitive directory (WSL's DrvFs) holds
 * side by side, and turn a case-only rename into no move at all, so the
 * rename's draft swap would delete the dirty buffer's only draft.
 * `bufferKey` (monaco-bound) and the cross-window `peerKey` share this formula.
 */

const external = (path: string, root: string, kind: 'external' | 'commit' = 'external') =>
  ({ kind, session: 's1', path, root }) satisfies EditorTab;

const ref = (tab: EditorTab): TabRef => ({ type: 'editor', tab });

const paths = (tree: ReturnType<typeof makeLeaf>) =>
  flattenTabs(tree).map((t) => (t.type === 'editor' ? t.tab.path : ''));

describe('identity under a Windows root', () => {
  const root = 'C:\\wsl\\repo';

  it('keeps two files whose names differ only in case apart', () => {
    const upper = external('README.md', root);
    const mixed = external('Readme.md', root);
    expect(tabKey(upper)).not.toBe(tabKey(mixed));
    expect(sameTab(upper, mixed)).toBe(false);
    expect(draftKey('s1', 'README.md', root)).not.toBe(draftKey('s1', 'Readme.md', root));
    expect(saverKey('s1', 'README.md', root)).not.toBe(saverKey('s1', 'Readme.md', root));
  });

  it('moves a draft on a case-only rename instead of deleting it in place', () => {
    // renameFileTab saves the dirty text under the new key, then deletes the
    // old one: the two must differ or the delete removes the only draft.
    expect(draftKey('s1', 'notes.md', root)).not.toBe(draftKey('s1', 'Notes.md', root));
    expect(draftKey('s1', 'x.JS', root)).not.toBe(draftKey('s1', 'x.js', root));
  });

  it('renames only the file that was renamed, and follows the other spelling', () => {
    const tree = makeLeaf([ref(external('README.md', root)), ref(external('Readme.md', root))]);
    expect(paths(renameBufferTabs(tree, external('Readme.md', root), 'readme.md'))).toEqual([
      'README.md',
      'readme.md',
    ]);

    const slot = { ...external('README.md', root), view: 'linked' as const };
    const following = makeLeaf([ref(slot)]);
    expect(retargetFollowingTabs(following, ref(external('README.md', root)))).toBe(following);
    expect(paths(retargetFollowingTabs(following, ref(external('Readme.md', root))))).toEqual([
      'Readme.md',
    ]);
  });
});

describe('key strings', () => {
  it('stay byte for byte what they were, on every host', () => {
    expect(tabKey(external('Readme.md', 'C:\\wsl\\repo'))).toBe(
      'external:s1::C:\\wsl\\repo:Readme.md',
    );
    expect(tabKey(external('A.md', 'C:\\repo', 'commit'))).toBe('commit:s1::C:\\repo:A.md');
    expect(tabKey(external('Docs/A.md', '/home/a/repo'))).toBe(
      'external:s1::/home/a/repo:Docs/A.md',
    );
    expect(tabKey({ session: 's1', path: 'Src/App.tsx' })).toBe('file:s1:::Src/App.tsx');
    expect(draftKey('s1', 'Src/App.tsx')).toBe('s1:Src%2FApp.tsx');
    expect(draftKey('s1', 'A.md', '/r')).toBe('s1:A.md:%2Fr');
    expect(draftKey('s1', 'A.md', 'C:\\r')).toBe('s1:A.md:C%3A%5Cr');
    expect(saverKey('s1', 'A.md', '/r')).toBe('s1:A.md:%2Fr');
  });
});
