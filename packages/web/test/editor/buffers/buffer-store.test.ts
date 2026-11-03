/**
 * Pure-logic tests for the buffer store (SPEC §8 editor tabs).
 *
 * `monaco-editor` cannot initialise under vitest's node environment (it
 * reaches for `window` at module load — verified locally: importing it here
 * throws `ReferenceError: window is not defined`), so the monaco-touching
 * half of buffer-store.ts (getOrCreateModel, replaceContent, and the
 * retainModel/releaseModel disposal wiring — anything that creates or edits a
 * real ITextModel) has no automated coverage here and must be exercised
 * manually in the browser (see the task report for the manual-verification
 * checklist). What IS pure — saved-version bookkeeping, the tab-label collision
 * rule, and the reference-count arithmetic — lives in `buffer-logic.ts` and is
 * fully covered below without touching monaco at all.
 */
import { describe, expect, it } from 'vitest';
import {
  RefCounter,
  SavedStateMap,
  editorTabLabel,
  type OpenTab,
} from '../../../src/features/editor/buffers/buffer-logic';

describe('editorTabLabel', () => {
  it('returns the plain basename when it is unique across open tabs', () => {
    const tabs: OpenTab[] = [{ session: 's1', path: 'src/api.ts' }];
    const branches = new Map([['s1', 'main']]);
    expect(editorTabLabel('src/api.ts', 's1', tabs, branches)).toBe('api.ts');
  });

  it('suffixes both tabs with their branch when two sessions share a basename', () => {
    const tabs: OpenTab[] = [
      { session: 's1', path: 'src/api.ts' },
      { session: 's2', path: 'lib/api.ts' },
    ];
    const branches = new Map([
      ['s1', 'main'],
      ['s2', 'alice/fix-auth'],
    ]);
    expect(editorTabLabel('src/api.ts', 's1', tabs, branches)).toBe('api.ts — main');
    expect(editorTabLabel('lib/api.ts', 's2', tabs, branches)).toBe('api.ts — alice/fix-auth');
  });

  it('falls back to the plain basename when the colliding session has no known branch', () => {
    const tabs: OpenTab[] = [
      { session: 's1', path: 'src/api.ts' },
      { session: 's2', path: 'lib/api.ts' },
    ];
    const branches = new Map([['s2', 'alice/fix-auth']]); // s1 unknown
    expect(editorTabLabel('src/api.ts', 's1', tabs, branches)).toBe('api.ts');
  });

  it('disambiguates two same-session, same-basename tabs by full path (branch would be identical)', () => {
    // Same session, two different files that happen to share a basename.
    // A branch suffix would be identical for both and wouldn't disambiguate,
    // so this falls back to the full path instead — documented choice.
    const tabs: OpenTab[] = [
      { session: 's1', path: 'src/api.ts' },
      { session: 's1', path: 'lib/api.ts' },
    ];
    const branches = new Map([['s1', 'main']]);
    expect(editorTabLabel('src/api.ts', 's1', tabs, branches)).toBe('src/api.ts');
    expect(editorTabLabel('lib/api.ts', 's1', tabs, branches)).toBe('lib/api.ts');
  });

  it('combines path and branch when a basename collides both within and across sessions', () => {
    // Three-way matrix: s1 has two same-basename paths open AND s2 has a
    // third. The two s1 tabs need path-based disambiguation (branch alone is
    // identical for both) and the branch suffix still distinguishes their
    // session from s2's.
    const tabs: OpenTab[] = [
      { session: 's1', path: 'src/api.ts' },
      { session: 's1', path: 'lib/api.ts' },
      { session: 's2', path: 'other/api.ts' },
    ];
    const branches = new Map([
      ['s1', 'main'],
      ['s2', 'alice/fix-auth'],
    ]);
    expect(editorTabLabel('src/api.ts', 's1', tabs, branches)).toBe('src/api.ts — main');
    expect(editorTabLabel('lib/api.ts', 's1', tabs, branches)).toBe('lib/api.ts — main');
    // s2's tab has no same-session collision: basename + branch suffices.
    expect(editorTabLabel('other/api.ts', 's2', tabs, branches)).toBe('api.ts — alice/fix-auth');
  });

  it('falls back to the path alone in a three-way collision when the branch is unknown', () => {
    const tabs: OpenTab[] = [
      { session: 's1', path: 'src/api.ts' },
      { session: 's1', path: 'lib/api.ts' },
      { session: 's2', path: 'other/api.ts' },
    ];
    const branches = new Map([['s2', 'alice/fix-auth']]); // s1 unknown
    expect(editorTabLabel('src/api.ts', 's1', tabs, branches)).toBe('src/api.ts');
    expect(editorTabLabel('lib/api.ts', 's1', tabs, branches)).toBe('lib/api.ts');
  });

  it('ignores the tab itself when scanning for collisions', () => {
    // Only one (session, path) tab open — must not "collide" with itself.
    const tabs: OpenTab[] = [{ session: 's1', path: 'src/api.ts' }];
    const branches = new Map([['s1', 'main']]);
    expect(editorTabLabel('src/api.ts', 's1', tabs, branches)).toBe('api.ts');
  });

  it('shows absolute paths when external roots share the same relative filename', () => {
    const tabs: OpenTab[] = [
      { session: 's1', path: 'README.md', root: '/repos/one' },
      { session: 's1', path: 'README.md', root: '/repos/two' },
    ];
    const branches = new Map([['s1', 'main']]);
    expect(editorTabLabel('README.md', 's1', tabs, branches, '/repos/one')).toBe(
      '/repos/one/README.md',
    );
    expect(editorTabLabel('README.md', 's1', tabs, branches, '/repos/two')).toBe(
      '/repos/two/README.md',
    );
  });

  it('shows worktree paths when colliding sessions share a branch', () => {
    const tabs: OpenTab[] = [
      { session: 's1', path: 'README.md' },
      { session: 's2', path: 'README.md' },
    ];
    const branches = new Map([
      ['s1', 'main'],
      ['s2', 'main'],
    ]);
    const directories = new Map([
      ['s1', '/worktrees/one'],
      ['s2', '/worktrees/two'],
    ]);
    expect(editorTabLabel('README.md', 's1', tabs, branches, undefined, directories)).toBe(
      '/worktrees/one/README.md — main',
    );
    expect(editorTabLabel('README.md', 's2', tabs, branches, undefined, directories)).toBe(
      '/worktrees/two/README.md — main',
    );
  });
});

describe('SavedStateMap', () => {
  it('reports not-dirty for a key with no recorded baseline', () => {
    const saved = new SavedStateMap();
    expect(saved.isDirty('k', 5)).toBe(false);
  });

  it('is dirty once the current version diverges from the saved baseline', () => {
    const saved = new SavedStateMap();
    saved.mark('k', 1, 1_000);
    expect(saved.isDirty('k', 1)).toBe(false); // untouched since save
    expect(saved.isDirty('k', 2)).toBe(true); // edited since save
  });

  it('clears dirty state when marked saved again at the new version', () => {
    const saved = new SavedStateMap();
    saved.mark('k', 1, 1_000);
    expect(saved.isDirty('k', 2)).toBe(true);
    saved.mark('k', 2, 2_000);
    expect(saved.isDirty('k', 2)).toBe(false);
  });

  it('tracks saved mtime per key', () => {
    const saved = new SavedStateMap();
    saved.mark('k', 1, 1_000);
    expect(saved.mtime('k')).toBe(1_000);
    expect(saved.mtime('unknown')).toBeUndefined();
  });

  it('lists exactly the dirty keys given each key current version', () => {
    const saved = new SavedStateMap();
    saved.mark('a', 1, 1_000);
    saved.mark('b', 1, 1_000);
    saved.mark('c', 1, 1_000);
    const currentVersions = new Map([
      ['a', 1], // untouched
      ['b', 2], // edited
      ['c', 3], // edited
    ]);
    expect(saved.dirtyKeys(currentVersions)).toEqual(['b', 'c']);
  });

  it('forgets a key on delete', () => {
    const saved = new SavedStateMap();
    saved.mark('k', 1, 1_000);
    saved.delete('k');
    expect(saved.mtime('k')).toBeUndefined();
    expect(saved.isDirty('k', 99)).toBe(false);
  });

  it('moves the saved version and mtime when a buffer identity changes', () => {
    const saved = new SavedStateMap();
    saved.mark('old', 1, 1_000);
    saved.rekey('old', 'new');
    expect(saved.mtime('old')).toBeUndefined();
    expect(saved.mtime('new')).toBe(1_000);
    expect(saved.isDirty('new', 2)).toBe(true);
  });
});

describe('RefCounter', () => {
  it('starts at zero for an unseen key', () => {
    const refs = new RefCounter();
    expect(refs.count('k')).toBe(0);
  });

  it('disposes only when the last holder releases', () => {
    const refs = new RefCounter();
    refs.retain('k'); // editor tab
    refs.retain('k'); // diff section
    expect(refs.count('k')).toBe(2);
    // First holder leaves — still held by the other, so no dispose.
    expect(refs.release('k')).toBe(false);
    expect(refs.count('k')).toBe(1);
    // Last holder leaves — dispose now.
    expect(refs.release('k')).toBe(true);
    expect(refs.count('k')).toBe(0);
  });

  it('a single holder disposes on its own release', () => {
    const refs = new RefCounter();
    refs.retain('k');
    expect(refs.release('k')).toBe(true);
    expect(refs.count('k')).toBe(0);
  });

  it('release without a matching retain disposes defensively and never goes negative', () => {
    const refs = new RefCounter();
    expect(refs.release('k')).toBe(true);
    expect(refs.count('k')).toBe(0);
    // A later retain/release pair still behaves normally.
    refs.retain('k');
    expect(refs.count('k')).toBe(1);
    expect(refs.release('k')).toBe(true);
  });

  it('tracks keys independently', () => {
    const refs = new RefCounter();
    refs.retain('a');
    refs.retain('b');
    refs.retain('b');
    expect(refs.release('a')).toBe(true);
    expect(refs.release('b')).toBe(false);
    expect(refs.count('a')).toBe(0);
    expect(refs.count('b')).toBe(1);
  });
});
