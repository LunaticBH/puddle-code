/**
 * Pure-logic tests for the editor tab-order helpers (SPEC §8 editor tabs) and
 * the `applyDraft` sequencing. Both are deliberately monaco-free — the tab
 * helpers operate on plain `{session, path}` records, and `applyDraft` takes a
 * structural model interface — so they run under vitest's node environment,
 * where `monaco-editor` itself cannot load (it reaches for `window` at import
 * time; see buffer-store.test.ts). The monaco-touching wiring around them is
 * covered by the browser smoke check recorded in the task report.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  activeAfterClose,
  addOrFocusTab,
  hasTab,
  removeTab,
  reorderTabs,
  tabKey,
  type EditorTab,
} from '../../../src/features/editor/tabs/editor-tabs';
import { applyDraft } from '../../../src/features/editor/buffers/buffer-logic';

const t = (session: string, path: string): EditorTab => ({ session, path });

describe('addOrFocusTab', () => {
  it('appends a tab that is not open yet', () => {
    const tabs = [t('s1', 'a.ts')];
    expect(addOrFocusTab(tabs, t('s1', 'b.ts'))).toEqual([t('s1', 'a.ts'), t('s1', 'b.ts')]);
  });

  it('leaves the list untouched when the tab is already open (focus, not duplicate)', () => {
    const tabs = [t('s1', 'a.ts'), t('s1', 'b.ts')];
    expect(addOrFocusTab(tabs, t('s1', 'a.ts'))).toEqual(tabs);
  });

  it('treats the same path under different sessions as distinct tabs', () => {
    const tabs = [t('s1', 'a.ts')];
    expect(addOrFocusTab(tabs, t('s2', 'a.ts'))).toEqual([t('s1', 'a.ts'), t('s2', 'a.ts')]);
  });

  it('keeps staged and unstaged source-control diffs distinct', () => {
    const staged: EditorTab = {
      kind: 'diff',
      session: 's1',
      path: 'a.ts',
      git_area: 'staged',
    };
    const unstaged: EditorTab = { ...staged, git_area: 'unstaged' };
    expect(tabKey(staged)).not.toBe(tabKey(unstaged));
    expect(addOrFocusTab([staged], unstaged)).toEqual([staged, unstaged]);
  });

  it('keeps one stable identity per following mode and apart from the target file', () => {
    const linked: EditorTab = { ...t('s1', 'a.md'), view: 'linked' };
    const retargetedLinked: EditorTab = { ...t('s2', 'b.md'), view: 'linked' };
    const locked: EditorTab = { ...t('s1', 'a.md'), view: 'locked' };
    expect(tabKey(linked)).toBe('linked');
    expect(tabKey(retargetedLinked)).toBe('linked');
    expect(tabKey(locked)).toBe('locked');
    expect(addOrFocusTab([linked], retargetedLinked)).toEqual([linked]);
    expect(addOrFocusTab([linked], locked)).toEqual([linked, locked]);
    expect(addOrFocusTab([linked], t('s1', 'a.md'))).toEqual([linked, t('s1', 'a.md')]);
  });
});

describe('hasTab / removeTab', () => {
  it('matches on both session and path', () => {
    const tabs = [t('s1', 'a.ts'), t('s2', 'a.ts')];
    expect(hasTab(tabs, t('s1', 'a.ts'))).toBe(true);
    expect(hasTab(tabs, t('s3', 'a.ts'))).toBe(false);
  });

  it('removes only the matching (session, path) tab', () => {
    const tabs = [t('s1', 'a.ts'), t('s2', 'a.ts'), t('s1', 'b.ts')];
    expect(removeTab(tabs, t('s2', 'a.ts'))).toEqual([t('s1', 'a.ts'), t('s1', 'b.ts')]);
  });
});

describe('activeAfterClose', () => {
  const tabs = [t('s1', 'a.ts'), t('s1', 'b.ts'), t('s1', 'c.ts')];

  it('returns the active tab unchanged when a different tab closes', () => {
    expect(activeAfterClose(tabs, t('s1', 'a.ts'), t('s1', 'c.ts'))).toEqual(t('s1', 'c.ts'));
  });

  it('lands on the right neighbour when the active tab closes', () => {
    expect(activeAfterClose(tabs, t('s1', 'b.ts'), t('s1', 'b.ts'))).toEqual(t('s1', 'c.ts'));
  });

  it('lands on the left neighbour when the last, active tab closes', () => {
    expect(activeAfterClose(tabs, t('s1', 'c.ts'), t('s1', 'c.ts'))).toEqual(t('s1', 'b.ts'));
  });

  it('returns null when the only tab closes', () => {
    expect(activeAfterClose([t('s1', 'a.ts')], t('s1', 'a.ts'), t('s1', 'a.ts'))).toBeNull();
  });

  it('returns null when nothing was active', () => {
    expect(activeAfterClose(tabs, t('s1', 'a.ts'), null)).toBeNull();
  });
});

describe('reorderTabs', () => {
  const tabs = [t('s1', 'a.ts'), t('s1', 'b.ts'), t('s1', 'c.ts')];

  it('moves a dragged tab in front of the drop target', () => {
    expect(reorderTabs(tabs, t('s1', 'c.ts'), t('s1', 'a.ts'))).toEqual([
      t('s1', 'c.ts'),
      t('s1', 'a.ts'),
      t('s1', 'b.ts'),
    ]);
  });

  it('is a no-op when a tab is dropped on itself', () => {
    expect(reorderTabs(tabs, t('s1', 'b.ts'), t('s1', 'b.ts'))).toEqual(tabs);
  });
});

describe('applyDraft', () => {
  interface FakeModel {
    getValue(): string;
    getFullModelRange(): string;
    pushEditOperations: ReturnType<typeof vi.fn>;
  }
  const fakeModel = (value: string): FakeModel => ({
    getValue: () => value,
    getFullModelRange: () => 'FULL_RANGE',
    pushEditOperations: vi.fn(),
  });

  it('pushes a full-range replacement with the draft content (registers as a dirty edit)', () => {
    const model = fakeModel('disk contents');
    expect(applyDraft(model, 'draft contents')).toBe(true);
    expect(model.pushEditOperations).toHaveBeenCalledTimes(1);
    const [selections, ops] = model.pushEditOperations.mock.calls[0]!;
    expect(selections).toBeNull();
    expect(ops).toEqual([{ range: 'FULL_RANGE', text: 'draft contents' }]);
  });

  it('does nothing when the draft already equals the disk content (stays clean)', () => {
    const model = fakeModel('same');
    expect(applyDraft(model, 'same')).toBe(false);
    expect(model.pushEditOperations).not.toHaveBeenCalled();
  });
});
