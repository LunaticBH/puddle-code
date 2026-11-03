import { describe, expect, it } from 'vitest';
import type { LayoutNode, LayoutSplit, TabRef, UiStateSnapshot } from '@puddle/shared';
import { UNTITLED_SESSION, uiStateSnapshotSchema } from '@puddle/shared';
import type { EditorTab } from '../../../src/features/editor/tabs/editor-tabs';
import {
  allLeaves,
  buildInitialTree,
  boundToLiveSession,
  closeTab,
  retargetFollowingTabs,
  dedupeIds,
  dropTab,
  findLeaf,
  hasDuplicateIds,
  reidNodes,
  flattenTabs,
  focusTab,
  leafContainingKey,
  makeLeaf,
  moveTab,
  normalise,
  openPreview,
  promoteTab,
  renameBufferTabs,
  resizeSplit,
  sameRef,
  setTabView,
  sourceTabLocation,
  splitLeaf,
  setCompileMode,
  tabRefKey,
  addTabToLeaf,
  addBackgroundTabToLeaf,
  pruneTabs,
} from '../../../src/features/workspace/layout/layout-tree';

const NIL = UNTITLED_SESSION;
const ed = (path: string, session = 's1'): TabRef => ({ type: 'editor', tab: { session, path } });
const term = (session: string): TabRef => ({ type: 'terminal', session });
const asSplit = (n: LayoutNode): LayoutSplit => {
  if (n.kind !== 'split') throw new Error('expected a split');
  return n;
};
const leafWith = (tree: LayoutNode, ref: TabRef) => leafContainingKey(tree, tabRefKey(ref))!;

describe('tab identity', () => {
  it('keys editors by tab identity and terminals by session', () => {
    expect(tabRefKey(term('t1'))).toBe('term:t1');
    expect(tabRefKey(ed('a.ts'))).toBe('editor:file:s1:::a.ts');
    expect(sameRef(ed('a.ts'), ed('a.ts'))).toBe(true);
    expect(sameRef(ed('a.ts'), ed('b.ts'))).toBe(false);
    expect(sameRef(term('t1'), term('t2'))).toBe(false);
  });
});

describe('makeLeaf', () => {
  it('activates the first tab by default, respects a provided key, nulls when empty', () => {
    expect(makeLeaf([ed('a.ts'), ed('b.ts')]).activeKey).toBe(tabRefKey(ed('a.ts')));
    expect(makeLeaf([ed('a.ts'), ed('b.ts')], tabRefKey(ed('b.ts'))).activeKey).toBe(
      tabRefKey(ed('b.ts')),
    );
    expect(makeLeaf([]).activeKey).toBeNull();
    // an activeKey not present falls back to the first tab
    expect(makeLeaf([ed('a.ts')], 'nope').activeKey).toBe(tabRefKey(ed('a.ts')));
  });
});

describe('compilation tabs', () => {
  it('adds an eager artefact permanently without changing the active tab', () => {
    const source = ed('paper.tex');
    const pdf: TabRef = {
      type: 'editor',
      tab: {
        kind: 'external',
        session: 's1',
        path: 'paper.pdf',
        root: '/tmp/puddle/latex/build',
        generated_by: 'latex',
      },
    };
    const leaf = makeLeaf([source]);
    const next = addBackgroundTabToLeaf(leaf, leaf.id, pdf);
    const result = allLeaves(next)[0]!;
    expect(result.tabs).toEqual([source, pdf]);
    expect(result.activeKey).toBe(tabRefKey(source));
    expect(result.previewKey).toBeNull();
  });

  it('keeps a source mode consistent across pane copies', () => {
    const source = ed('paper.tex');
    const left = makeLeaf([source]);
    const tree = splitLeaf(left, left.id, 'right', source);
    const eager = setCompileMode(
      tree,
      (source as Extract<TabRef, { type: 'editor' }>).tab,
      'eager',
    );
    expect(
      allLeaves(eager).map(
        (leaf) => (leaf.tabs[0] as Extract<TabRef, { type: 'editor' }>).tab.compile_mode,
      ),
    ).toEqual(['eager', 'eager']);
  });
});

describe('splitLeaf', () => {
  it('right/left produce a row with the new leaf after/before', () => {
    const a = makeLeaf([ed('a.ts')]);
    const right = asSplit(splitLeaf(a, a.id, 'right', term('t1')));
    expect(right.direction).toBe('row');
    expect(right.sizes).toEqual([50, 50]);
    expect(right.children[0]!.id).toBe(a.id); // original stays first
    expect((right.children[1] as never as { tabs: TabRef[] }).tabs).toEqual([term('t1')]);

    const left = asSplit(splitLeaf(a, a.id, 'left', term('t1')));
    expect(leafWith(left, term('t1')).id).toBe(asSplit(left).children[0]!.id); // new leaf first
  });

  it('top/bottom produce a column', () => {
    const a = makeLeaf([ed('a.ts')]);
    expect(asSplit(splitLeaf(a, a.id, 'top', ed('b.ts'))).direction).toBe('col');
    expect(asSplit(splitLeaf(a, a.id, 'bottom', ed('b.ts'))).direction).toBe('col');
  });
});

describe('flattenTabs', () => {
  it('lists every tab in DFS order', () => {
    const a = makeLeaf([ed('a.ts')]);
    const tree = splitLeaf(a, a.id, 'right', term('t1'));
    expect(flattenTabs(tree).map(tabRefKey)).toEqual(['editor:file:s1:::a.ts', 'term:t1']);
  });
});

describe('dropTab', () => {
  it('moves a terminal between leaves (unique — leaves it nowhere else)', () => {
    const a = makeLeaf([ed('a.ts')]);
    let tree = splitLeaf(a, a.id, 'right', ed('b.ts')); // [leafA(a.ts), leafB(b.ts)]
    const leafA = leafWith(tree, ed('a.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    // seed a terminal into leafA, then move it to leafB
    tree = dropTab(tree, {
      ref: term('t1'),
      fromLeafId: leafA.id,
      toLeafId: leafA.id,
      edge: 'center',
    });
    const withTermA = leafWith(tree, term('t1'));
    tree = dropTab(tree, {
      ref: term('t1'),
      fromLeafId: withTermA.id,
      toLeafId: leafB.id,
      edge: 'center',
    });
    expect(flattenTabs(tree).filter((t) => sameRef(t, term('t1')))).toHaveLength(1); // exactly once
    expect(leafContainingKey(tree, 'term:t1')!.tabs.map(tabRefKey)).toContain('term:t1');
  });

  it('moves an editor dropped into a different leaf (a drag leaves nothing behind)', () => {
    const a = makeLeaf([ed('a.ts'), ed('x.ts')]);
    const tree = splitLeaf(a, a.id, 'right', ed('b.ts'));
    const leafA = leafWith(tree, ed('a.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    const next = dropTab(tree, {
      ref: ed('a.ts'),
      fromLeafId: leafA.id,
      toLeafId: leafB.id,
      edge: 'center',
    });
    // a.ts appears exactly once, in leaf B; the source keeps only x.ts.
    expect(flattenTabs(next).filter((t) => sameRef(t, ed('a.ts')))).toHaveLength(1);
    expect(leafWith(next, ed('a.ts')).id).toBe(leafB.id);
    expect(findLeaf(next, leafA.id)!.tabs.map(tabRefKey)).toEqual(['editor:file:s1:::x.ts']);
  });

  it('moves a generated LaTeX PDF as an ordinary persistent external tab', () => {
    const pdf: TabRef = {
      type: 'editor',
      tab: {
        kind: 'external',
        session: 's1',
        path: 'paper.pdf',
        root: '/repo/.puddle/latex/0123456789abcdef01234567/current',
        generated_by: 'latex',
      },
    };
    const source = makeLeaf([ed('paper.tex'), pdf]);
    const tree = splitLeaf(source, source.id, 'bottom', ed('notes.md'));
    const sourceLeaf = leafWith(tree, pdf);
    const destinationLeaf = leafWith(tree, ed('notes.md'));
    const next = dropTab(tree, {
      ref: pdf,
      fromLeafId: sourceLeaf.id,
      toLeafId: destinationLeaf.id,
      edge: 'center',
    });

    expect(findLeaf(next, sourceLeaf.id)!.tabs.map(tabRefKey)).not.toContain(tabRefKey(pdf));
    expect(findLeaf(next, destinationLeaf.id)!.tabs).toContainEqual(pdf);
    expect(leafWith(next, pdf).previewKey).toBeNull();
  });

  it('reorders within the same leaf (move, not duplicate)', () => {
    const leaf = makeLeaf([ed('a.ts'), ed('b.ts'), ed('c.ts')]);
    const next = moveTab(leaf, ed('c.ts'), leaf.id, leaf.id, 0);
    expect(allLeaves(next)[0]!.tabs.map((t) => tabRefKey(t))).toEqual([
      'editor:file:s1:::c.ts',
      'editor:file:s1:::a.ts',
      'editor:file:s1:::b.ts',
    ]);
  });

  it('compensates a rightward same-leaf reorder for the dragged tab still being visible', () => {
    // The strip shows [a, b, c]; the user drops `a` before `c` (visible index 2).
    const leaf = makeLeaf([ed('a.ts'), ed('b.ts'), ed('c.ts')]);
    const next = moveTab(leaf, ed('a.ts'), leaf.id, leaf.id, 2);
    expect(allLeaves(next)[0]!.tabs.map(tabRefKey)).toEqual([
      'editor:file:s1:::b.ts',
      'editor:file:s1:::a.ts',
      'editor:file:s1:::c.ts',
    ]);
    // …and dropping past the last tab (visible index 3) lands at the end.
    const toEnd = moveTab(leaf, ed('a.ts'), leaf.id, leaf.id, 3);
    expect(allLeaves(toEnd)[0]!.tabs.map(tabRefKey)).toEqual([
      'editor:file:s1:::b.ts',
      'editor:file:s1:::c.ts',
      'editor:file:s1:::a.ts',
    ]);
  });

  it('inserts at the given index on a cross-leaf center drop', () => {
    const a = makeLeaf([ed('a.ts')]);
    const tree = splitLeaf(a, a.id, 'right', ed('b.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    const next = dropTab(tree, {
      ref: ed('a.ts'),
      fromLeafId: leafWith(tree, ed('a.ts')).id,
      toLeafId: leafB.id,
      edge: 'center',
      index: 0,
    });
    // Source emptied and collapsed; B's strip is [a, b].
    expect(allLeaves(next)).toHaveLength(1);
    expect(allLeaves(next)[0]!.tabs.map(tabRefKey)).toEqual([
      'editor:file:s1:::a.ts',
      'editor:file:s1:::b.ts',
    ]);
  });

  it('edge-splits the target leaf, moving the tab out of its source', () => {
    const a = makeLeaf([ed('a.ts'), ed('x.ts')]);
    const tree = splitLeaf(a, a.id, 'right', ed('b.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    const next = dropTab(tree, {
      ref: ed('a.ts'),
      fromLeafId: leafWith(tree, ed('a.ts')).id,
      toLeafId: leafB.id,
      edge: 'bottom',
    });
    // a.ts lives only in the new leaf below B.
    expect(flattenTabs(next).filter((t) => sameRef(t, ed('a.ts')))).toHaveLength(1);
    expect(leafWith(next, ed('a.ts')).id).not.toBe(leafB.id);
  });

  it('moving one copy of a duplicated file leaves the other pane’s copy in place', () => {
    // Two panes each hold a.ts (a sidebar copy-drop); a third pane is the
    // target. Dragging ONE chip moves only that tab — the copies are
    // independent (the tree-wide removal that vacuumed up the sibling shipped
    // in v0.0.30's copy-drop and was fixed the same day).
    const seed = makeLeaf([ed('a.ts')]);
    let tree = splitLeaf(seed, seed.id, 'right', ed('b.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    // The second copy of a.ts, beside b.ts.
    tree = dropTab(tree, {
      ref: ed('a.ts'),
      fromLeafId: leafB.id,
      toLeafId: leafB.id,
      edge: 'center',
      copy: true,
    });
    // A third pane to move B's copy into.
    tree = splitLeaf(tree, leafB.id, 'bottom', ed('c.ts'));
    const leafC = leafWith(tree, ed('c.ts'));
    const next = dropTab(tree, {
      ref: ed('a.ts'),
      fromLeafId: leafB.id,
      toLeafId: leafC.id,
      edge: 'center',
    });
    // Still two copies: the untouched pane's stayed put; B's moved to C.
    expect(flattenTabs(next).filter((t) => sameRef(t, ed('a.ts')))).toHaveLength(2);
    expect(findLeaf(next, leafB.id)!.tabs.map(tabRefKey)).not.toContain('editor:file:s1:::a.ts');
    expect(findLeaf(next, leafC.id)!.tabs.map(tabRefKey)).toContain('editor:file:s1:::a.ts');
  });

  it('moving a copy into a pane that already holds the file merges to one tab there', () => {
    // A[a] and B[a, b]: dragging A's chip into B cannot double up within B —
    // the pane keeps one tab per file; A empties and collapses.
    const seed = makeLeaf([ed('a.ts')]);
    let tree = splitLeaf(seed, seed.id, 'right', ed('b.ts'));
    const leafA = leafWith(tree, ed('a.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    tree = dropTab(tree, {
      ref: ed('a.ts'),
      fromLeafId: leafB.id,
      toLeafId: leafB.id,
      edge: 'center',
      copy: true,
    });
    const next = dropTab(tree, {
      ref: ed('a.ts'),
      fromLeafId: leafA.id,
      toLeafId: leafB.id,
      edge: 'center',
    });
    expect(flattenTabs(next).filter((t) => sameRef(t, ed('a.ts')))).toHaveLength(1);
    expect(allLeaves(next)).toHaveLength(1); // A emptied and collapsed away
  });

  it('pins a preview tab on any drop (drag = deliberate placement)', () => {
    // Preview a.ts in its own leaf, then split another leaf off it and drag the
    // preview across — the moved tab must arrive permanent.
    const seed = makeLeaf([ed('x.ts')]);
    const withPreview = openPreview(seed, seed.id, ed('a.ts'));
    const src = leafWith(withPreview, ed('a.ts'));
    expect(src.previewKey).toBe(tabRefKey(ed('a.ts')));
    const tree = splitLeaf(withPreview, src.id, 'right', ed('b.ts'));
    const to = leafWith(tree, ed('b.ts'));
    const next = dropTab(tree, {
      ref: ed('a.ts'),
      fromLeafId: leafWith(tree, ed('a.ts')).id,
      toLeafId: to.id,
      edge: 'center',
    });
    for (const leaf of allLeaves(next)) {
      expect(leaf.previewKey).not.toBe(tabRefKey(ed('a.ts')));
    }
    // A same-leaf reorder pins too.
    const reordered = moveTab(withPreview, ed('a.ts'), src.id, src.id, 0);
    expect(leafWith(reordered, ed('a.ts')).previewKey).toBeNull();
  });

  it('a copy-drop opens a second tab of an already-open file (sidebar drag)', () => {
    const a = makeLeaf([ed('a.ts'), ed('x.ts')]);
    const tree = splitLeaf(a, a.id, 'right', ed('b.ts'));
    const leafA = leafWith(tree, ed('a.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    const next = dropTab(tree, {
      ref: ed('a.ts'),
      fromLeafId: leafB.id,
      toLeafId: leafB.id,
      edge: 'center',
      copy: true,
    });
    // a.ts now lives in BOTH panes; the source lost nothing.
    expect(flattenTabs(next).filter((t) => sameRef(t, ed('a.ts')))).toHaveLength(2);
    expect(findLeaf(next, leafA.id)!.tabs.map(tabRefKey)).toContain('editor:file:s1:::a.ts');
    const target = findLeaf(next, leafB.id)!;
    expect(target.tabs.map(tabRefKey)).toContain('editor:file:s1:::a.ts');
    expect(target.activeKey).toBe(tabRefKey(ed('a.ts')));
  });

  it('a copy-drop into a pane already holding the file focuses it — one copy per pane', () => {
    const a = makeLeaf([ed('a.ts'), ed('b.ts')], tabRefKey(ed('b.ts')));
    const next = dropTab(a, {
      ref: ed('a.ts'),
      fromLeafId: a.id,
      toLeafId: a.id,
      edge: 'center',
      copy: true,
    });
    const leaf = allLeaves(next)[0]!;
    expect(leaf.tabs.filter((t) => sameRef(t, ed('a.ts')))).toHaveLength(1);
    expect(leaf.activeKey).toBe(tabRefKey(ed('a.ts')));
  });

  it('an edge copy-drop splits a pane on its own only file (same file, two panes)', () => {
    // The gesture move semantics made impossible: split the pane so the same
    // file shows twice (e.g. markdown source beside its preview).
    const leaf = makeLeaf([ed('a.ts')]);
    const next = dropTab(leaf, {
      ref: ed('a.ts'),
      fromLeafId: leaf.id,
      toLeafId: leaf.id,
      edge: 'right',
      copy: true,
    });
    expect(allLeaves(next)).toHaveLength(2);
    expect(flattenTabs(next).filter((t) => sameRef(t, ed('a.ts')))).toHaveLength(2);
  });

  it('copy is ignored for terminals — one PTY, one tab, still a move', () => {
    const a = makeLeaf([term('t1')]);
    const tree = splitLeaf(a, a.id, 'right', ed('b.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    const next = dropTab(tree, {
      ref: term('t1'),
      fromLeafId: leafWith(tree, term('t1')).id,
      toLeafId: leafB.id,
      edge: 'center',
      copy: true,
    });
    expect(flattenTabs(next).filter((t) => sameRef(t, term('t1')))).toHaveLength(1);
    expect(leafContainingKey(next, 'term:t1')!.id).toBe(leafB.id);
  });
});

describe('closeTab', () => {
  it('activates the right neighbour, else left', () => {
    const leaf = makeLeaf([ed('a.ts'), ed('b.ts'), ed('c.ts')], tabRefKey(ed('b.ts')));
    const afterB = closeTab(leaf, leaf.id, tabRefKey(ed('b.ts')));
    expect(allLeaves(afterB)[0]!.activeKey).toBe(tabRefKey(ed('c.ts'))); // right neighbour
    const afterC = closeTab(afterB, allLeaves(afterB)[0]!.id, tabRefKey(ed('c.ts')));
    expect(allLeaves(afterC)[0]!.activeKey).toBe(tabRefKey(ed('a.ts'))); // left, no right neighbour
  });

  it('drops an emptied leaf and collapses the split', () => {
    const a = makeLeaf([ed('a.ts')]);
    const tree = splitLeaf(a, a.id, 'right', ed('b.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    const collapsed = closeTab(tree, leafB.id, tabRefKey(ed('b.ts')));
    expect(collapsed.kind).toBe('leaf'); // split collapsed to the surviving leaf
    expect(flattenTabs(collapsed).map(tabRefKey)).toEqual(['editor:file:s1:::a.ts']);
  });

  it('preserves a sole empty root leaf (the empty-workspace state)', () => {
    const leaf = makeLeaf([ed('a.ts')]);
    const empty = closeTab(leaf, leaf.id, tabRefKey(ed('a.ts')));
    expect(empty.kind).toBe('leaf');
    expect(flattenTabs(empty)).toEqual([]);
  });
});

describe('focusTab & resizeSplit', () => {
  it('focusTab sets the active key only when the tab is present', () => {
    const leaf = makeLeaf([ed('a.ts'), ed('b.ts')]);
    expect(allLeaves(focusTab(leaf, leaf.id, tabRefKey(ed('b.ts'))))[0]!.activeKey).toBe(
      tabRefKey(ed('b.ts')),
    );
  });

  it('resizeSplit writes sizes for the matching split id', () => {
    const a = makeLeaf([ed('a.ts')]);
    const split = asSplit(splitLeaf(a, a.id, 'right', ed('b.ts')));
    const resized = asSplit(resizeSplit(split, split.id, [30, 70]));
    expect(resized.sizes).toEqual([30, 70]);
  });
});

describe('normalise', () => {
  it('flattens a same-direction child split, distributing its size', () => {
    // Hand-build a row containing a row (via two right-splits) and check flattening.
    const a = makeLeaf([ed('a.ts')]);
    let tree = splitLeaf(a, a.id, 'right', ed('b.ts')); // row[A,B] sizes[50,50]
    const leafB = leafWith(tree, ed('b.ts'));
    tree = splitLeaf(tree, leafB.id, 'right', ed('c.ts')); // B becomes row[B,C]; flattened → row[A,B,C]
    const split = asSplit(tree);
    expect(split.direction).toBe('row');
    expect(split.children).toHaveLength(3); // flattened, not nested
    expect(split.children.every((c) => c.kind === 'leaf')).toBe(true);
    // A kept 50; B/C split the other 50 → [50, 25, 25]
    expect(split.sizes).toEqual([50, 25, 25]);
  });

  it('collapses a single-child split and fixes a stale activeKey', () => {
    const leaf = { kind: 'leaf', id: 'x', tabs: [ed('a.ts')], activeKey: 'stale' } as LayoutNode;
    expect(allLeaves(normalise(leaf))[0]!.activeKey).toBe(tabRefKey(ed('a.ts')));
  });
});

describe('buildInitialTree (legacy migration)', () => {
  const base = (over: Partial<UiStateSnapshot>): UiStateSnapshot =>
    uiStateSnapshotSchema.parse({ ...over });

  it('stacks editor tabs above terminals in a column with layout sizes', () => {
    const s = crypto.randomUUID();
    const snap = base({
      editor_tabs: [{ session: s, path: 'a.ts' }],
      session_tabs: [s],
      layout: { editor: 35, session: 65 },
    });
    const tree = asSplit(buildInitialTree(snap));
    expect(tree.direction).toBe('col');
    expect(tree.sizes).toEqual([35, 65]);
    expect(flattenTabs(tree).map(tabRefKey)).toEqual([`editor:file:${s}:::a.ts`, `term:${s}`]);
  });

  it('collapses to a single leaf when only one side has tabs', () => {
    const s = crypto.randomUUID();
    expect(buildInitialTree(base({ session_tabs: [s] })).kind).toBe('leaf');
    expect(buildInitialTree(base({ editor_tabs: [{ session: s, path: 'a.ts' }] })).kind).toBe(
      'leaf',
    );
  });

  it('returns an empty leaf for an empty snapshot', () => {
    const tree = buildInitialTree(base({}));
    expect(tree.kind).toBe('leaf');
    expect(flattenTabs(tree)).toEqual([]);
  });
});

describe('schema round-trip', () => {
  it('a built tree survives parse through uiStateSnapshotSchema unchanged', () => {
    const s = crypto.randomUUID();
    const tree = buildInitialTree(
      uiStateSnapshotSchema.parse({
        editor_tabs: [{ session: s, path: 'a.ts' }],
        session_tabs: [s],
      }),
    );
    const parsed = uiStateSnapshotSchema.parse({ layout_tree: tree });
    expect(parsed.layout_tree).toEqual(tree);
  });

  it('defaults layout_tree to null on a legacy snapshot', () => {
    expect(uiStateSnapshotSchema.parse({}).layout_tree).toBeNull();
  });
});

describe('findLeaf', () => {
  it('locates a leaf by id and returns null for an unknown id', () => {
    const leaf = makeLeaf([ed('a.ts')]);
    expect(findLeaf(leaf, leaf.id)?.id).toBe(leaf.id);
    expect(findLeaf(leaf, 'nope')).toBeNull();
  });
});

describe('preview tabs (VSCode-style ephemeral tabs)', () => {
  const keyOf = (ref: TabRef) => tabRefKey(ref);

  it('a single-click open becomes the preview tab (previewKey === activeKey)', () => {
    const leaf = makeLeaf([]);
    const next = leafWith(openPreview(leaf, leaf.id, ed('a.ts')), ed('a.ts'));
    expect(next.tabs.map(keyOf)).toEqual([keyOf(ed('a.ts'))]);
    expect(next.activeKey).toBe(keyOf(ed('a.ts')));
    expect(next.previewKey).toBe(keyOf(ed('a.ts')));
  });

  it('a second single-click replaces the preview tab in place (one slot)', () => {
    const leaf = makeLeaf([]);
    const t1 = openPreview(leaf, leaf.id, ed('a.ts'));
    const t2 = openPreview(t1, leaf.id, ed('b.ts'));
    const l = leafWith(t2, ed('b.ts'));
    // a.ts is gone; b.ts took its slot and is the new preview
    expect(l.tabs.map(keyOf)).toEqual([keyOf(ed('b.ts'))]);
    expect(l.previewKey).toBe(keyOf(ed('b.ts')));
  });

  it('does not replace a permanent tab, and re-opening a permanent tab keeps it', () => {
    const leaf = makeLeaf([]);
    const withPerm = addTabToLeaf(leaf, leaf.id, ed('a.ts')); // permanent
    const withPreview = openPreview(withPerm, leaf.id, ed('b.ts')); // preview alongside
    const l = leafWith(withPreview, ed('b.ts'));
    expect(l.tabs.map(keyOf)).toEqual([keyOf(ed('a.ts')), keyOf(ed('b.ts'))]);
    expect(l.previewKey).toBe(keyOf(ed('b.ts')));
    // single-clicking the permanent tab just focuses it — no preview change
    const focused = leafWith(openPreview(withPreview, l.id, ed('a.ts')), ed('a.ts'));
    expect(focused.previewKey).toBe(keyOf(ed('b.ts')));
    expect(focused.activeKey).toBe(keyOf(ed('a.ts')));
  });

  it('never discards a preview terminal — it pins it and opens the new tab alongside', () => {
    const leaf = makeLeaf([]);
    const withTerm = openPreview(leaf, leaf.id, term('t1')); // preview terminal (live PTY)
    const withFile = openPreview(withTerm, leaf.id, ed('a.ts')); // open a file preview
    const l = leafWith(withFile, term('t1'));
    // the terminal survives (now permanent), the file is the new preview
    expect(l.tabs.map(keyOf)).toEqual([keyOf(term('t1')), keyOf(ed('a.ts'))]);
    expect(l.previewKey).toBe(keyOf(ed('a.ts')));
  });

  // Skimming a directory of markdown by single-clicking each file: the slot was
  // rendered, so every file that CAN be rendered arrives rendered.
  it('a rendered preview slot stays rendered for the next previewable file', () => {
    const leaf = makeLeaf([]);
    const first = openPreview(leaf, leaf.id, {
      type: 'editor',
      tab: { session: 's1', path: 'a.md', view: 'preview' },
    });
    const second = leafWith(openPreview(first, leaf.id, ed('b.md')), ed('b.md'));
    const tab = second.tabs[0];
    expect(tab?.type === 'editor' && tab.tab.view).toBe('preview');
  });

  it('inherits nothing for a file that has no rendered view, or from a source slot', () => {
    const leaf = makeLeaf([]);
    const rendered = openPreview(leaf, leaf.id, {
      type: 'editor',
      tab: { session: 's1', path: 'a.md', view: 'preview' },
    });
    const code = leafWith(openPreview(rendered, leaf.id, ed('b.ts')), ed('b.ts'));
    expect(code.tabs[0]?.type === 'editor' && code.tabs[0].tab.view).toBeUndefined();
    // and a SOURCE markdown slot passes nothing on either
    const source = openPreview(leaf, leaf.id, ed('a.md'));
    const next = leafWith(openPreview(source, leaf.id, ed('b.md')), ed('b.md'));
    expect(next.tabs[0]?.type === 'editor' && next.tabs[0].tab.view).toBeUndefined();
  });

  it('a view the caller asked for wins over the slot it replaces', () => {
    const leaf = makeLeaf([]);
    const rendered = openPreview(leaf, leaf.id, {
      type: 'editor',
      tab: { session: 's1', path: 'a.md', view: 'preview' },
    });
    const asked: TabRef = {
      type: 'editor',
      tab: { session: 's1', path: 'b.md', view: 'source' },
    };
    const next = leafWith(openPreview(rendered, leaf.id, asked), asked);
    expect(next.tabs[0]?.type === 'editor' && next.tabs[0].tab.view).toBe('source');
  });

  it('double-click (promoteTab) pins the preview tab', () => {
    const leaf = makeLeaf([]);
    const previewed = openPreview(leaf, leaf.id, ed('a.ts'));
    const pinned = leafWith(promoteTab(previewed, keyOf(ed('a.ts'))), ed('a.ts'));
    expect(pinned.previewKey).toBeNull();
    expect(pinned.tabs.map(keyOf)).toEqual([keyOf(ed('a.ts'))]);
  });

  it('opening a preview tab permanently (addTabToLeaf) promotes it', () => {
    const leaf = makeLeaf([]);
    const previewed = openPreview(leaf, leaf.id, ed('a.ts'));
    const promoted = leafWith(addTabToLeaf(previewed, leaf.id, ed('a.ts')), ed('a.ts'));
    expect(promoted.previewKey).toBeNull();
  });

  it('closing the preview tab clears previewKey (normalise)', () => {
    const leaf = makeLeaf([]);
    const withPerm = addTabToLeaf(leaf, leaf.id, ed('a.ts'));
    const withPreview = openPreview(withPerm, leaf.id, ed('b.ts'));
    const l = leafWith(withPreview, ed('b.ts'));
    const closed = leafWith(closeTab(withPreview, l.id, keyOf(ed('b.ts'))), ed('a.ts'));
    expect(closed.previewKey).toBeNull();
    expect(closed.tabs.map(keyOf)).toEqual([keyOf(ed('a.ts'))]);
  });
});

describe('setTabView', () => {
  it('rewrites the matching editor tab in place, keeping its key and active state', () => {
    const a = ed('README.md');
    const tree = makeLeaf([a, ed('b.ts'), term('t1')]);
    const next = setTabView(tree, tree.id, tabRefKey(a), 'preview');
    const leaf = allLeaves(next)[0]!;
    const updated = leaf.tabs[0]!;
    expect(updated.type).toBe('editor');
    expect(updated.type === 'editor' && updated.tab.view).toBe('preview');
    // Identity unchanged: same key, active tab untouched, others untouched.
    expect(tabRefKey(updated)).toBe(tabRefKey(a));
    expect(leaf.activeKey).toBe(tree.activeKey);
    expect(leaf.tabs[1]).toEqual(ed('b.ts'));
    expect(leaf.tabs[2]).toEqual(term('t1'));
    // Toggling back to source round-trips.
    const back = setTabView(next, allLeaves(next)[0]!.id, tabRefKey(a), 'source');
    const backTab = allLeaves(back)[0]!.tabs[0]!;
    expect(backTab.type === 'editor' && backTab.tab.view).toBe('source');
  });

  it('a tab ref carrying view survives the snapshot schema round-trip', () => {
    const s = crypto.randomUUID();
    const tree = normalise(
      makeLeaf([{ type: 'editor', tab: { session: s, path: 'README.md', view: 'preview' } }]),
    );
    const parsed = uiStateSnapshotSchema.parse({ layout_tree: tree });
    expect(parsed.layout_tree).toEqual(tree);
  });

  it('is a no-op for terminals and unknown keys', () => {
    const tree = makeLeaf([term('t1')]);
    expect(setTabView(tree, tree.id, 'term:t1', 'preview')).toEqual(tree);
    expect(setTabView(tree, tree.id, 'editor:file:s1:::nope.md', 'preview')).toEqual(tree);
  });

  // The same file open in two panes: one key, two tabs. Toggling one pane's view
  // must leave the other pane's alone, or source-beside-preview is impossible.
  it('touches only the named leaf when the same file is open in two panes', () => {
    const a = ed('README.md');
    const base = makeLeaf([a, ed('b.ts')]);
    const split = dropTab(base, {
      ref: ed('b.ts'),
      fromLeafId: base.id,
      toLeafId: base.id,
      edge: 'right',
    });
    // Put the same file in the second pane too, then flip only that one.
    const both = addTabToLeaf(split, allLeaves(split)[1]!.id, a);
    const next = setTabView(both, allLeaves(both)[1]!.id, tabRefKey(a), 'preview');
    const [first, second] = allLeaves(next);
    const viewIn = (leaf: typeof first) => {
      const t = leaf?.tabs.find((x) => tabRefKey(x) === tabRefKey(a));
      return t?.type === 'editor' ? t.tab.view : undefined;
    };
    expect(viewIn(second)).toBe('preview');
    expect(viewIn(first)).toBeUndefined();
  });
});

describe('renameBufferTabs', () => {
  it('retargets file and diff views of the same buffer and remaps leaf pointers', () => {
    const source: EditorTab = { session: 's1', path: 'docs/old.md' };
    const file: TabRef = { type: 'editor', tab: source };
    const diff: TabRef = {
      type: 'editor',
      tab: { kind: 'diff', session: 's1', path: 'docs/old.md' },
    };
    const otherSession = ed('docs/old.md', 's2');
    const leaf = makeLeaf([file, diff, otherSession], tabRefKey(diff));
    const tree = { ...leaf, previewKey: tabRefKey(file) };

    const next = renameBufferTabs(tree, source, 'docs/new.md');
    const renamed = allLeaves(next)[0]!;
    expect(
      renamed.tabs.map((ref) =>
        ref.type === 'editor' ? `${ref.tab.kind ?? 'file'}:${ref.tab.path}` : '',
      ),
    ).toEqual(['file:docs/new.md', 'diff:docs/new.md', 'file:docs/old.md']);
    expect(renamed.activeKey).toBe(
      tabRefKey({
        type: 'editor',
        tab: { kind: 'diff', session: 's1', path: 'docs/new.md' },
      }),
    );
    expect(renamed.previewKey).toBe(tabRefKey(ed('docs/new.md')));
  });

  it('retargets matching following slots but leaves historical commit paths alone', () => {
    const sourceTab: EditorTab = { session: 's1', path: 'README.md' };
    const source: TabRef = { type: 'editor', tab: sourceTab };
    const linked: TabRef = {
      type: 'editor',
      tab: { session: 's1', path: 'README.md', view: 'linked' },
    };
    const commit: TabRef = {
      type: 'editor',
      tab: { kind: 'commit', session: 's1', path: 'README.md', sha: 'abc1234' },
    };
    const tree = makeLeaf([source, linked, commit]);

    const paths = flattenTabs(renameBufferTabs(tree, sourceTab, 'GUIDE.md')).map((ref) =>
      ref.type === 'editor' ? ref.tab.path : '',
    );
    expect(paths).toEqual(['GUIDE.md', 'GUIDE.md', 'README.md']);
  });

  it('is a referential no-op when no live tab shares the source buffer', () => {
    const tree = makeLeaf([ed('a.ts')]);
    expect(renameBufferTabs(tree, { session: 's1', path: 'missing.ts' }, 'next.ts')).toBe(tree);
  });
});

describe('following preview slots (SPEC §8)', () => {
  const linked = (path: string, session = 's1'): TabRef => ({
    type: 'editor',
    tab: { session, path, view: 'linked' },
  });
  const locked = (path: string, session = 's1'): TabRef => ({
    type: 'editor',
    tab: { session, path, view: 'locked' },
  });
  const followingTabsOf = (tree: LayoutNode) =>
    flattenTabs(tree).flatMap((t) =>
      t.type === 'editor' && (t.tab.view === 'linked' || t.tab.view === 'locked') ? [t.tab] : [],
    );

  it('keys linked and locked as distinct constant slots, never by target', () => {
    expect(tabRefKey(linked('README.md'))).toBe('editor:linked');
    expect(tabRefKey(linked('docs/other.md', 's2'))).toBe('editor:linked');
    expect(tabRefKey(locked('README.md'))).toBe('editor:locked');
    expect(tabRefKey(locked('docs/other.md', 's2'))).toBe('editor:locked');
    expect(tabRefKey(linked('README.md'))).not.toBe(tabRefKey(locked('README.md')));
    // ...so a slot never collides with an ordinary tab of the file it shows.
    expect(tabRefKey(ed('README.md'))).not.toBe(tabRefKey(linked('README.md')));
    expect(tabRefKey(ed('README.md'))).not.toBe(tabRefKey(locked('README.md')));
  });

  it('entering linked mode remaps the leaf pointers onto the slot key', () => {
    const a = ed('README.md');
    const base = makeLeaf([a, ed('b.ts')], tabRefKey(a));
    const tree = { ...base, previewKey: tabRefKey(a) };
    const next = setTabView(tree, tree.id, tabRefKey(a), 'linked');
    const leaf = allLeaves(next)[0]!;
    expect(leaf.activeKey).toBe('editor:linked');
    expect(leaf.previewKey).toBe('editor:linked');
    const t = leaf.tabs[0]!;
    expect(t.type === 'editor' && t.tab.view).toBe('linked');
  });

  it('entering and crossing to locked mode remaps both leaf pointers', () => {
    const a = ed('README.md');
    const base = makeLeaf([a, linked('README.md')], tabRefKey(a));
    const preview = { ...base, previewKey: tabRefKey(a) };
    const entered = setTabView(preview, preview.id, tabRefKey(a), 'locked');
    expect(entered.kind).toBe('leaf');
    if (entered.kind !== 'leaf') return;
    expect(entered.activeKey).toBe('editor:locked');
    expect(entered.previewKey).toBe('editor:locked');
    expect(entered.tabs.map(tabRefKey)).toEqual(['editor:locked', 'editor:linked']);

    const crossed = setTabView(entered, entered.id, 'editor:locked', 'linked');
    expect(crossed.kind).toBe('leaf');
    if (crossed.kind !== 'leaf') return;
    // The existing linked owner wins the collision and the locked slot dissolves.
    expect(crossed.tabs.map(tabRefKey)).toEqual(['editor:linked']);
    expect(crossed.activeKey).toBe('editor:linked');
    expect(crossed.previewKey).toBeNull();
  });

  it('leaving linked mode onto a file already open in the leaf dissolves the slot into it', () => {
    const a = ed('README.md');
    const tree = makeLeaf([a, linked('README.md')], 'editor:linked');
    const next = setTabView(tree, tree.id, 'editor:linked', 'source');
    const leaf = allLeaves(next)[0]!;
    expect(leaf.tabs.map((t) => tabRefKey(t))).toEqual([tabRefKey(a)]);
    expect(leaf.activeKey).toBe(tabRefKey(a));
  });

  it('retargets every slot, across panes, in one pass — keys unmoved', () => {
    const base = makeLeaf([ed('a.md'), linked('a.md')]);
    const split = dropTab(base, {
      ref: linked('a.md'),
      fromLeafId: base.id,
      toLeafId: base.id,
      edge: 'right',
    });
    const withTwo = addTabToLeaf(split, allLeaves(split)[0]!.id, linked('a.md'));
    const next = retargetFollowingTabs(withTwo, ed('b.md', 's2'));
    const slots = followingTabsOf(next);
    expect(slots).toHaveLength(2);
    for (const slot of slots) {
      expect(slot.path).toBe('b.md');
      expect(slot.session).toBe('s2');
    }
    // The slot key is constant, so active/preview state never had to move.
    expect(allLeaves(next).map((l) => l.activeKey)).toEqual(
      allLeaves(withTwo).map((l) => l.activeKey),
    );
  });

  it('retargets linked and locked together while preserving their modes', () => {
    const tree = makeLeaf([linked('a.md'), locked('a.md')]);
    const next = retargetFollowingTabs(tree, ed('b.html', 's2'));
    expect(followingTabsOf(next)).toEqual([
      { session: 's2', path: 'b.html', view: 'linked' },
      { session: 's2', path: 'b.html', view: 'locked' },
    ]);
  });

  it('retargets nothing for terminals, non-renderable tabs, other slots, or the current target', () => {
    const tree = makeLeaf([ed('a.md'), linked('a.md')]);
    expect(retargetFollowingTabs(tree, term('t1'))).toBe(tree);
    expect(retargetFollowingTabs(tree, ed('code.ts'))).toBe(tree);
    expect(retargetFollowingTabs(tree, linked('b.md'))).toBe(tree);
    expect(retargetFollowingTabs(tree, locked('b.md'))).toBe(tree);
    // Already showing the target: the SAME object, so callers skip the persist.
    expect(retargetFollowingTabs(tree, ed('a.md'))).toBe(tree);
  });

  it("carries an external target's kind and root into the slot", () => {
    const external: TabRef = {
      type: 'editor',
      tab: { session: 's1', path: 'notes.md', kind: 'external', root: '/abs' },
    };
    const tree = makeLeaf([linked('a.md')]);
    const next = retargetFollowingTabs(tree, external);
    const t = allLeaves(next)[0]!.tabs[0]!;
    expect(t.type === 'editor' && t.tab).toEqual({
      session: 's1',
      path: 'notes.md',
      kind: 'external',
      root: '/abs',
      view: 'linked',
    });
  });

  it('resolves the associated ordinary source tab by leaf and rooted identity', () => {
    const rooted: TabRef = {
      type: 'editor',
      tab: { kind: 'external', session: 's1', path: 'notes.md', root: '/one' },
    };
    const otherRoot: TabRef = {
      type: 'editor',
      tab: { kind: 'external', session: 's1', path: 'notes.md', root: '/two' },
    };
    const first = makeLeaf([rooted]);
    let tree = splitLeaf(first, first.id, 'right', otherRoot);
    const second = leafWith(tree, otherRoot);
    tree = addTabToLeaf(tree, second.id, rooted);

    const target: EditorTab = {
      kind: 'external',
      session: 's1',
      path: 'notes.md',
      root: '/one',
      view: 'linked',
    };
    expect(sourceTabLocation(tree, target, second.id)?.leafId).toBe(second.id);
    expect(sourceTabLocation(tree, { ...target, root: '/missing' })).toBeNull();
  });

  it('openPreview never replaces a linked slot in the preview position', () => {
    const base = makeLeaf([linked('a.md')]);
    const tree = { ...base, previewKey: 'editor:linked' };
    const next = openPreview(tree, base.id, ed('b.ts'));
    const leaf = allLeaves(next)[0]!;
    expect(leaf.tabs.map((t) => tabRefKey(t))).toEqual(['editor:linked', tabRefKey(ed('b.ts'))]);
    expect(leaf.previewKey).toBe(tabRefKey(ed('b.ts')));
  });

  it('openPreview never replaces a locked slot in the preview position', () => {
    const base = makeLeaf([locked('a.md')]);
    const tree = { ...base, previewKey: 'editor:locked' };
    const next = openPreview(tree, base.id, ed('b.ts'));
    const leaf = allLeaves(next)[0]!;
    expect(leaf.tabs.map((t) => tabRefKey(t))).toEqual(['editor:locked', tabRefKey(ed('b.ts'))]);
    expect(leaf.previewKey).toBe(tabRefKey(ed('b.ts')));
  });

  it('a linked tab ref survives the snapshot schema round-trip', () => {
    const s = crypto.randomUUID();
    const tree = normalise(
      makeLeaf([{ type: 'editor', tab: { session: s, path: 'a.md', view: 'linked' } }]),
    );
    const parsed = uiStateSnapshotSchema.parse({ layout_tree: tree });
    expect(parsed.layout_tree).toEqual(tree);
  });

  it('a locked tab ref survives the snapshot schema round-trip', () => {
    const s = crypto.randomUUID();
    const tree = normalise(
      makeLeaf([{ type: 'editor', tab: { session: s, path: 'a.md', view: 'locked' } }]),
    );
    const parsed = uiStateSnapshotSchema.parse({ layout_tree: tree });
    expect(parsed.layout_tree).toEqual(tree);
  });
});

describe('node identity', () => {
  const twin = (): LayoutNode => {
    const leaf = makeLeaf([term('t1')]);
    // Two panes under one id: what sharding one tree into copies used to yield.
    return { kind: 'split', id: 'sp', direction: 'row', children: [leaf, leaf], sizes: [50, 50] };
  };

  it('detects a repeated id and treats a healthy tree as clean', () => {
    expect(hasDuplicateIds(twin())).toBe(true);
    expect(hasDuplicateIds(makeLeaf([term('t1')]))).toBe(false);
    expect(hasDuplicateIds(splitLeaf(makeLeaf([ed('a.ts')]), '', 'right', term('t1')))).toBe(false);
  });

  it('reidNodes copies the structure and shares no id with the original', () => {
    const tree = splitLeaf(
      makeLeaf([ed('a.ts')]),
      allLeaves(makeLeaf([]))[0]!.id,
      'right',
      term('t1'),
    );
    const copy = reidNodes(tree);
    expect(flattenTabs(copy)).toEqual(flattenTabs(tree));
    expect(hasDuplicateIds(copy)).toBe(false);
    const ids = new Set(allLeaves(tree).map((l) => l.id));
    expect(allLeaves(copy).some((l) => ids.has(l.id))).toBe(false);
  });

  it('dedupeIds re-ids only the repeats and leaves a clean tree untouched', () => {
    const clean = makeLeaf([term('t1')]);
    expect(dedupeIds(clean)).toBe(clean); // same object — safe on every load
    const corrupt = twin();
    const healed = dedupeIds(corrupt);
    expect(hasDuplicateIds(healed)).toBe(false);
    // the first occurrence keeps its id, so a focused pane survives the repair
    const [first, second] = allLeaves(healed);
    expect(first!.id).toBe(allLeaves(corrupt)[0]!.id);
    expect(second!.id).not.toBe(first!.id);
    expect(second!.tabs).toEqual(first!.tabs);
  });
});

describe('session-less tabs', () => {
  const untitled = (): TabRef => ({
    type: 'editor',
    tab: { session: NIL, path: 'untitled-1.md', kind: 'untitled' },
  });
  const external = (): TabRef => ({
    type: 'editor',
    tab: { session: NIL, path: 'README.md', kind: 'external', root: '/repos/thing' },
  });

  it('survive a prune against the live session set', () => {
    // The nil uuid means "no session applies" — an untitled draft (10.3) and a
    // directory-target tab (12.4) both carry it, and neither can be orphaned by
    // a session ending. Pruning them away silently dropped drafts on reload.
    const keep = boundToLiveSession(new Set(['live']));
    expect(keep(untitled())).toBe(true);
    expect(keep(external())).toBe(true);
    expect(keep(term('live'))).toBe(true);
    expect(keep(term('gone'))).toBe(false);
  });

  it('are kept by pruneTabs while dead-session tabs go', () => {
    const tree = makeLeaf([untitled(), term('live'), term('gone'), external()]);
    const pruned = pruneTabs(tree, boundToLiveSession(new Set(['live'])));
    expect(flattenTabs(pruned).map(tabRefKey)).toEqual([
      tabRefKey(untitled()),
      'term:live',
      tabRefKey(external()),
    ]);
  });
});
