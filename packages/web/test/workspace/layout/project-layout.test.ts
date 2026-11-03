import { describe, expect, it } from 'vitest';
import {
  UNTITLED_SESSION,
  uiStateSnapshotSchema,
  type SavedLayout,
  type TabRef,
  type UiStateSnapshot,
} from '@puddle/shared';
import type { LayoutNode } from '@puddle/shared';
import {
  flattenTabs,
  hasDuplicateIds,
  joinTrees,
  makeLeaf,
  tabRefKey,
} from '../../../src/features/workspace/layout/layout-tree';
import {
  loadLayoutPatch,
  mergeShardedLayouts,
  parkedTerminalSessions,
  scopedSnapshot,
  scopeUiState,
  splitToProjects,
  unionToProfile,
} from '../../../src/features/workspace/layout/project-layout';
import type { UiStateHandle } from '../../../src/features/workspace/use-ui-state';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const PA = 'aaaaaaaaaa';
const PB = 'bbbbbbbbbb';

const term = (session: string): TabRef => ({ type: 'terminal', session });
const ed = (session: string, path: string): TabRef => ({ type: 'editor', tab: { session, path } });
const untitled = (): TabRef => ({
  type: 'editor',
  tab: { session: UNTITLED_SESSION, path: 'untitled-1.md', kind: 'untitled' },
});
const snap = (over: Record<string, unknown>): UiStateSnapshot => uiStateSnapshotSchema.parse(over);
const keys = (tree: Parameters<typeof flattenTabs>[0]) => flattenTabs(tree).map(tabRefKey);
const nodeIds = (node: LayoutNode): string[] =>
  node.kind === 'leaf' ? [node.id] : [node.id, ...node.children.flatMap(nodeIds)];

const OWNER = new Map([
  [S1, PA],
  [S2, PB],
  [S3, PB],
]);

describe('splitToProjects', () => {
  it('gives each project the shared tree pruned to its own tabs', () => {
    const s = snap({
      layout_tree: makeLeaf([term(S1), ed(S2, 'a.ts'), term(S3)]),
      active_session: S2,
    });
    const patch = splitToProjects(s, [PA, PB], OWNER, null);
    expect(patch.layout_mode).toBe('project');
    const layouts = patch.project_layouts!;
    expect(keys(layouts[PA]!.layout_tree!)).toEqual([tabRefKey(term(S1))]);
    expect(keys(layouts[PB]!.layout_tree!)).toEqual([
      tabRefKey(ed(S2, 'a.ts')),
      tabRefKey(term(S3)),
    ]);
    // the bound session lands only in its own project's slice
    expect(layouts[PA]!.active_session).toBeNull();
    expect(layouts[PB]!.active_session).toBe(S2);
  });

  it('sends worktree-agnostic untitled drafts to the project that was open', () => {
    const s = snap({ layout_tree: makeLeaf([untitled(), term(S1)]) });
    const layouts = splitToProjects(s, [PA, PB], OWNER, PB).project_layouts!;
    expect(keys(layouts[PA]!.layout_tree!)).toEqual([tabRefKey(term(S1))]);
    expect(keys(layouts[PB]!.layout_tree!)).toEqual([tabRefKey(untitled())]);
    // …and to the first project when the flip happened with none open
    const fallback = splitToProjects(s, [PA, PB], OWNER, null).project_layouts!;
    expect(keys(fallback[PA]!.layout_tree!)).toContain(tabRefKey(untitled()));
  });

  it('rebuilds a legacy flat snapshot (null layout_tree) before splitting', () => {
    const s = snap({ session_tabs: [S1, S2], active_session: S1 });
    const layouts = splitToProjects(s, [PA, PB], OWNER, null).project_layouts!;
    expect(keys(layouts[PA]!.layout_tree!)).toEqual([tabRefKey(term(S1))]);
    expect(layouts[PA]!.active_session).toBe(S1);
    expect(keys(layouts[PB]!.layout_tree!)).toEqual([tabRefKey(term(S2))]);
  });

  it('stamps shards as unnamed (layout_ref null)', () => {
    const s = snap({ layout_tree: makeLeaf([term(S1)]), layout_ref: 7 });
    const layouts = splitToProjects(s, [PA], OWNER, null).project_layouts!;
    expect(layouts[PA]!.layout_ref).toBeNull();
  });

  it('gives every shard its own node ids — they are copies of one tree', () => {
    const s = snap({ layout_tree: makeLeaf([term(S1), term(S2)]) });
    const layouts = splitToProjects(s, [PA, PB], OWNER, null).project_layouts!;
    const ids = [PA, PB].flatMap((p) => nodeIds(layouts[p]!.layout_tree!));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain((s.layout_tree as { id: string }).id);
  });
});

describe('mergeShardedLayouts', () => {
  const slice = (session: string, layoutRef: number | null = null) => ({
    layout_tree: makeLeaf([term(session)]),
    active_session: null,
    layout_ref: layoutRef,
  });

  it('lets existing slices win, fills gaps from the shard, and overrides beat both', () => {
    const sharded = { [PA]: slice(S1), [PB]: slice(S2) };
    const existing = { [PA]: slice(S3, 4) };
    const override = { [PB]: slice(S3, 9) };
    const merged = mergeShardedLayouts(sharded, existing, override);
    expect(merged[PA]).toEqual(existing[PA]); // preserved, not re-sharded
    expect(merged[PB]).toEqual(override[PB]); // the loaded layout wins
    const noOverride = mergeShardedLayouts(sharded, existing);
    expect(noOverride[PB]).toEqual(sharded[PB]); // shard fills the gap
  });
});

describe('unionToProfile', () => {
  it('unions slices in the given order, dedupes tabs, and clears the slices', () => {
    const s = snap({
      layout_mode: 'project',
      project_layouts: {
        [PA]: { layout_tree: makeLeaf([term(S1), ed(S2, 'a.ts')]), active_session: null },
        [PB]: { layout_tree: makeLeaf([ed(S2, 'a.ts'), term(S2)]), active_session: S2 },
      },
    });
    const patch = unionToProfile(s, [PA, PB]);
    expect(patch.layout_mode).toBe('profile');
    expect(patch.project_layouts).toEqual({});
    // PA leads, so PB's duplicate of a.ts is pruned; structures sit side by side
    expect(keys(patch.layout_tree!)).toEqual([
      tabRefKey(term(S1)),
      tabRefKey(ed(S2, 'a.ts')),
      tabRefKey(term(S2)),
    ]);
    expect(patch.active_session).toBe(S2);
  });

  it('appends slices missing from the order and survives an empty record', () => {
    const s = snap({
      layout_mode: 'project',
      project_layouts: { [PB]: { layout_tree: makeLeaf([term(S2)]), active_session: S2 } },
    });
    // PB is not in the order — its slice still joins the union
    expect(keys(unionToProfile(s, [PA]).layout_tree!)).toEqual([tabRefKey(term(S2))]);
    const empty = unionToProfile(snap({ layout_mode: 'project' }), [PA]);
    expect(flattenTabs(empty.layout_tree!)).toEqual([]);
    expect(empty.active_session).toBeNull();
  });
});

describe('the profile → project → profile round trip', () => {
  // The v0.0.23 crash: the shards all kept the source tree's node ids, so the
  // union set several panes side by side under ONE id — duplicate React keys
  // and a Group whose `defaultLayout` collapsed to a single entry, which took
  // the workspace down in every window that loaded the snapshot.
  it('never unions two panes under one node id', () => {
    const start = snap({ layout_tree: makeLeaf([term(S1), term(S2), term(S3)]) });
    const split = splitToProjects(start, [PA, PB], OWNER, PA);
    const inProject = snap({ ...start, ...split });
    // each project's own slice is a healthy tree on its own
    for (const p of [PA, PB]) {
      expect(hasDuplicateIds(inProject.project_layouts[p]!.layout_tree!)).toBe(false);
    }
    const union = unionToProfile(inProject, [PA, PB]);
    expect(hasDuplicateIds(union.layout_tree!)).toBe(false);
    // and no tab is lost on the way back
    expect(keys(union.layout_tree!).sort()).toEqual(
      [term(S1), term(S2), term(S3)].map(tabRefKey).sort(),
    );
  });

  it('heals a snapshot whose slices already share ids (written before the fix)', () => {
    const shared = makeLeaf([term(S1)]);
    const corrupt = snap({
      layout_mode: 'project',
      project_layouts: {
        [PA]: { layout_tree: shared, active_session: null },
        [PB]: { layout_tree: { ...shared, tabs: [term(S2)] }, active_session: null },
      },
    });
    expect(hasDuplicateIds(unionToProfile(corrupt, [PA, PB]).layout_tree!)).toBe(false);
  });
});

describe('joinTrees', () => {
  it('keeps each tree as a row sibling and drops emptied ones', () => {
    const joined = joinTrees([makeLeaf([term(S1)]), makeLeaf([term(S1)]), makeLeaf([term(S2)])]);
    // the middle tree emptied by dedupe contributes no pane
    expect(joined.kind).toBe('split');
    expect(keys(joined)).toEqual([tabRefKey(term(S1)), tabRefKey(term(S2))]);
  });

  it('returns a lone tree without a wrapping split and an empty leaf for none', () => {
    const only = makeLeaf([term(S1)]);
    expect(joinTrees([only])).toEqual(only);
    expect(flattenTabs(joinTrees([]))).toEqual([]);
  });
});

describe('loadLayoutPatch', () => {
  const saved = (over: Partial<SavedLayout>): SavedLayout => ({
    id: 7,
    profile_id: 'ffffffffff',
    scope: 'profile',
    project_id: null,
    name: 'test',
    layout_tree: null,
    active_session: null,
    created_at: '2026-08-03T00:00:00Z',
    updated_at: '2026-08-03T00:00:00Z',
    ...over,
  });
  const ctx = (currentProject: string | null = PA) => ({
    alive: new Set([S1, S2]),
    sessionProject: OWNER,
    projectIds: [PA, PB],
    currentProject,
  });

  it('profile scope: installs top-level, prunes dead tabs, keeps slices untouched', () => {
    const s = snap({
      layout_mode: 'project',
      project_layouts: { [PB]: { layout_tree: makeLeaf([term(S2)]), active_session: null } },
    });
    const dead = '99999999-9999-4999-8999-999999999999';
    const { patch, projectBased } = loadLayoutPatch(
      s,
      saved({ layout_tree: makeLeaf([term(S1), term(dead), untitled()]), active_session: dead }),
      ctx(),
    );
    expect(projectBased).toBe(false);
    expect(patch.layout_mode).toBe('profile');
    expect(patch.layout_ref).toBe(7);
    // the dead terminal pruned, the untitled draft kept
    expect(keys(patch.layout_tree!)).toEqual([tabRefKey(term(S1)), tabRefKey(untitled())]);
    expect(patch.active_session).toBeNull();
    // the union is suppressed AND nothing is erased: slices stay out of the patch
    expect(patch.project_layouts).toBeUndefined();
  });

  it('project scope under project mode: replaces only the target slice', () => {
    const s = snap({
      layout_mode: 'project',
      project_layouts: { [PB]: { layout_tree: makeLeaf([term(S2)]), active_session: S2 } },
    });
    const { patch, projectBased } = loadLayoutPatch(
      s,
      saved({ scope: 'project', project_id: PA, layout_tree: makeLeaf([term(S1)]) }),
      ctx(),
    );
    expect(projectBased).toBe(true);
    expect(patch.layout_mode).toBeUndefined(); // already project — no restamp
    expect(keys(patch.project_layouts![PA]!.layout_tree!)).toEqual([tabRefKey(term(S1))]);
    expect(patch.project_layouts![PA]!.layout_ref).toBe(7);
    expect(patch.project_layouts![PB]).toEqual(s.project_layouts[PB]); // untouched
  });

  it("cross-project load targets the layout's own project, never the open one", () => {
    const s = snap({
      layout_mode: 'project',
      project_layouts: {
        // the open project's layout: unnamed and unsaved
        [PA]: { layout_tree: makeLeaf([term(S1)]), active_session: S1 },
      },
    });
    const { patch } = loadLayoutPatch(
      s,
      saved({ scope: 'project', project_id: PB, layout_tree: makeLeaf([term(S2)]) }),
      ctx(PA), // PA is the open project — it must not be overridden
    );
    expect(patch.project_layouts![PA]).toEqual(s.project_layouts[PA]);
    expect(keys(patch.project_layouts![PB]!.layout_tree!)).toEqual([tabRefKey(term(S2))]);
    expect(patch.project_layouts![PB]!.layout_ref).toBe(7);
  });

  it('project scope under profile mode: shards the others, target takes the layout', () => {
    const s = snap({ layout_tree: makeLeaf([term(S1), term(S2)]) });
    const { patch, projectBased } = loadLayoutPatch(
      s,
      saved({ scope: 'project', project_id: PA, layout_tree: makeLeaf([ed(S1, 'a.ts')]) }),
      ctx(),
    );
    expect(projectBased).toBe(true);
    expect(patch.layout_mode).toBe('project');
    // PA gets the LOADED layout, not its shard of the profile tree
    expect(keys(patch.project_layouts![PA]!.layout_tree!)).toEqual([tabRefKey(ed(S1, 'a.ts'))]);
    expect(patch.project_layouts![PA]!.layout_ref).toBe(7);
    // PB gets its shard, as the plain setting flip would have given it
    expect(keys(patch.project_layouts![PB]!.layout_tree!)).toEqual([tabRefKey(term(S2))]);
    expect(patch.project_layouts![PB]!.layout_ref).toBeNull();
  });

  it('project scope under profile mode: an existing stored slice beats its shard', () => {
    const stored = { layout_tree: makeLeaf([ed(S2, 'kept.ts')]), active_session: null };
    const s = snap({
      layout_tree: makeLeaf([term(S1), term(S2)]),
      project_layouts: { [PB]: stored },
    });
    const { patch } = loadLayoutPatch(
      s,
      saved({ scope: 'project', project_id: PA, layout_tree: null }),
      ctx(),
    );
    expect(patch.project_layouts![PB]).toEqual(s.project_layouts[PB]);
  });
});

describe('scopedSnapshot', () => {
  it('reads the project slice and blanks the profile-wide legacy fields', () => {
    const s = snap({
      layout_tree: makeLeaf([term(S1)]),
      active_session: S1,
      session_tabs: [S1],
      editor_tabs: [{ session: S1, path: 'a.ts' }],
      layout_mode: 'project',
      project_layouts: { [PB]: { layout_tree: makeLeaf([term(S2)]), active_session: S2 } },
    });
    const scoped = scopedSnapshot(s, PB);
    expect(keys(scoped.layout_tree!)).toEqual([tabRefKey(term(S2))]);
    expect(scoped.active_session).toBe(S2);
    expect(scoped.session_tabs).toEqual([]);
    expect(scoped.editor_tabs).toEqual([]);
    // a project with no slice yet is a fresh empty workspace
    const fresh = scopedSnapshot(s, PA);
    expect(fresh.layout_tree).toBeNull();
    expect(fresh.active_session).toBeNull();
  });
});

describe('scopeUiState', () => {
  const handle = (initial: UiStateSnapshot) => {
    let current = initial;
    const base: UiStateHandle = {
      loaded: true,
      snapshot: initial,
      current: () => current,
      update: (patch) => {
        current = { ...current, ...patch };
      },
    };
    return { base, state: () => current };
  };

  it('is the base handle itself when disabled', () => {
    const { base } = handle(snap({}));
    expect(scopeUiState(base, PA, false)).toBe(base);
  });

  it('routes layout keys into the slice and passes the rest through', () => {
    const { base, state } = handle(snap({ layout_mode: 'project' }));
    const scoped = scopeUiState(base, PA, true);
    const tree = makeLeaf([term(S1)]);
    scoped.update({ layout_tree: tree, sidebar_collapsed: true });
    expect(state().layout_tree).toBeNull(); // top level untouched
    expect(state().project_layouts[PA]!.layout_tree).toEqual(tree);
    expect(state().sidebar_collapsed).toBe(true);
  });

  it('merges same-tick updates through current() instead of clobbering', () => {
    const { base, state } = handle(snap({ layout_mode: 'project' }));
    const scoped = scopeUiState(base, PA, true);
    const tree = makeLeaf([term(S1)]);
    scoped.update({ layout_tree: tree });
    scoped.update({ active_session: S1 });
    expect(state().project_layouts[PA]).toEqual({
      layout_tree: tree,
      active_session: S1,
      layout_ref: null,
    });
  });
});

describe('parkedTerminalSessions', () => {
  const slices = (over: Record<string, { tabs: TabRef[] }>) =>
    Object.fromEntries(
      Object.entries(over).map(([pid, { tabs }]) => [
        pid,
        { layout_tree: makeLeaf(tabs), active_session: null, layout_ref: null },
      ]),
    );

  it('collects the terminals other projects hold open, and not this project’s', () => {
    const record = slices({
      [PA]: { tabs: [term(S1), ed(S1, 'a.ts')] },
      [PB]: { tabs: [term(S2), term(S3)] },
    });
    expect(parkedTerminalSessions(record, PA).sort()).toEqual([S2, S3].sort());
    expect(parkedTerminalSessions(record, PB)).toEqual([S1]);
  });

  it('ignores editor tabs, empty slices, and duplicates across projects', () => {
    const record = {
      ...slices({
        [PA]: { tabs: [ed(S1, 'a.ts'), untitled()] },
        [PB]: { tabs: [term(S2)] },
      }),
      cccccccccc: { layout_tree: null, active_session: null, layout_ref: null },
      dddddddddd: {
        layout_tree: makeLeaf([term(S2)]),
        active_session: null,
        layout_ref: null,
      },
    };
    // S1 only ever has an editor tab, so nothing keeps a terminal for it; S2 is
    // in two slices and is listed once.
    expect(parkedTerminalSessions(record, PA)).toEqual([S2]);
  });

  it('is empty when only the current project has a slice', () => {
    expect(parkedTerminalSessions(slices({ [PA]: { tabs: [term(S1)] } }), PA)).toEqual([]);
  });
});
