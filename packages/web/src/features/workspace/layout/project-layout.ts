import {
  UNTITLED_SESSION,
  type ProjectLayout,
  type SavedLayout,
  type TabRef,
  type UiStateSnapshot,
} from '@puddle/shared';
import { buildInitialTree, flattenTabs, joinTrees, pruneTabs, reidNodes } from './layout-tree';
import type { UiStateHandle } from '../use-ui-state';

/**
 * Project-based layout (SPEC §11): with the client setting on, the centre
 * editor persists one layout PER (profile, project) instead of one profile-wide
 * surface. The per-project slices live inside the same profile snapshot
 * (`project_layouts`, keyed by project id), so the two-tier persistence —
 * sessionStorage working set over the debounced profile row — carries them
 * unchanged. This module is the pure machinery: the scoped view of a snapshot,
 * the scoped handle Workspace swaps in, and the two one-shot transitions
 * (profile → project splits the shared tree; project → profile unions the
 * slices). DOM-free and unit-tested.
 */

const EMPTY_PROJECT_LAYOUT: ProjectLayout = {
  layout_tree: null,
  active_session: null,
  layout_ref: null,
};

/** The session a tab binds to (a terminal its own, an editor tab its worktree's). */
function tabSession(ref: TabRef): string {
  return ref.type === 'terminal' ? ref.session : ref.tab.session;
}

/**
 * Every session with a TERMINAL tab in a stored slice other than `exceptProject`
 * — the terminals another project's layout is holding open while you work in
 * this one. They stay mounted (parked and detached) rather than being rebuilt
 * on return: a project switch changes which tree is live, and without this the
 * keep-alive host saw the other project's terminals vanish, disposed their DOM,
 * and every switch back rebuilt an xterm and replayed its scrollback — the
 * blink project-based layout used to cost (fixed 2026-08-04, when the setting
 * became the default). Profile-wide layout never had the problem: one tree
 * holds every tab, so nothing left it.
 */
export function parkedTerminalSessions(
  slices: Record<string, ProjectLayout>,
  exceptProject: string,
): string[] {
  const out = new Set<string>();
  for (const [projectId, slice] of Object.entries(slices)) {
    if (projectId === exceptProject || !slice.layout_tree) continue;
    for (const ref of flattenTabs(slice.layout_tree)) {
      if (ref.type === 'terminal') out.add(ref.session);
    }
  }
  return [...out];
}

/**
 * The snapshot as project `projectId` sees it: the top-level layout keys are
 * replaced by that project's slice (absent slice → a fresh empty workspace).
 * The legacy flat fields describe the PROFILE-wide tree, so they are blanked —
 * a project with no slice yet must not rebuild the whole profile's tabs.
 */
export function scopedSnapshot(base: UiStateSnapshot, projectId: string): UiStateSnapshot {
  const slice = base.project_layouts[projectId];
  return {
    ...base,
    layout_tree: slice?.layout_tree ?? null,
    active_session: slice?.active_session ?? null,
    layout_ref: slice?.layout_ref ?? null,
    session_tabs: [],
    editor_tabs: [],
    active_editor_tab: null,
  };
}

/**
 * A UiStateHandle whose layout keys are scoped to one project: reads come from
 * `project_layouts[projectId]`, and updates touching `layout_tree` /
 * `active_session` / `layout_ref` are routed back into that slice (reading the LATEST record
 * through `current()`, so same-tick updates never clobber each other). Every
 * other key passes through untouched. Disabled, it is the base handle itself.
 */
export function scopeUiState(
  base: UiStateHandle,
  projectId: string,
  enabled: boolean,
): UiStateHandle {
  if (!enabled) return base;
  return {
    loaded: base.loaded,
    snapshot: scopedSnapshot(base.snapshot, projectId),
    current: () => scopedSnapshot(base.current(), projectId),
    update(patch) {
      const slice: Partial<ProjectLayout> = {};
      const rest: Partial<UiStateSnapshot> = { ...patch };
      if ('layout_tree' in patch) {
        slice.layout_tree = patch.layout_tree ?? null;
        delete rest.layout_tree;
      }
      if ('active_session' in patch) {
        slice.active_session = patch.active_session ?? null;
        delete rest.active_session;
      }
      if ('layout_ref' in patch) {
        slice.layout_ref = patch.layout_ref ?? null;
        delete rest.layout_ref;
      }
      if (Object.keys(slice).length > 0) {
        const record = base.current().project_layouts;
        rest.project_layouts = {
          ...record,
          [projectId]: { ...(record[projectId] ?? EMPTY_PROJECT_LAYOUT), ...slice },
        };
      }
      if (Object.keys(rest).length > 0) base.update(rest);
    },
  };
}

/**
 * The profile → project transition: split the profile-wide tree into one slice
 * per project, each keeping the shared tree's structure with only that
 * project's tabs (worktree-agnostic untitled drafts follow `untitledHome`, the
 * project open when the setting flipped). Returns the patch to apply to the
 * BASE snapshot; the top-level tree is left untouched — nothing reads it while
 * `layout_mode` is `project`, and the union overwrites it on the way back.
 *
 * Every shard is re-id'd (`reidNodes`): the slices are copies of ONE tree, and
 * ids that survived the copy would collide the moment the union sets the
 * slices side by side — panes aliasing each other and a renderer holding two
 * siblings under one key (see layout-tree's "Node identity").
 */
export function splitToProjects(
  snap: UiStateSnapshot,
  projectIds: readonly string[],
  sessionProject: ReadonlyMap<string, string>,
  untitledHome: string | null,
): Partial<UiStateSnapshot> {
  const tree = snap.layout_tree ?? buildInitialTree(snap);
  const layouts: Record<string, ProjectLayout> = {};
  for (const pid of projectIds) {
    const pruned = pruneTabs(tree, (ref) => {
      const sid = tabSession(ref);
      if (sid === UNTITLED_SESSION) return pid === (untitledHome ?? projectIds[0]);
      return sessionProject.get(sid) === pid;
    });
    layouts[pid] = {
      layout_tree: reidNodes(pruned),
      active_session:
        snap.active_session !== null && sessionProject.get(snap.active_session) === pid
          ? snap.active_session
          : null,
      // A shard is a derived fragment, not the saved layout it split from.
      layout_ref: null,
    };
  }
  return { layout_mode: 'project', project_layouts: layouts };
}

/**
 * How a freshly sharded record lands over whatever slices a snapshot already
 * holds (SPEC §11): an existing slice always wins — per-project layout storage
 * is never erased by a transition, so slices preserved through an earlier
 * profile-layout load survive the round trip — the shard only fills projects
 * without one, and explicit `overrides` beat both (the saved-layout load path
 * pins the current project to the layout being loaded).
 */
export function mergeShardedLayouts(
  sharded: Record<string, ProjectLayout>,
  existing: Record<string, ProjectLayout>,
  overrides: Record<string, ProjectLayout> = {},
): Record<string, ProjectLayout> {
  return { ...sharded, ...existing, ...overrides };
}

export interface LoadLayoutContext {
  /** Live (non-archived) session ids — dead tabs prune out of the loaded tree. */
  alive: ReadonlySet<string>;
  sessionProject: ReadonlyMap<string, string>;
  /** Every project of the profile (archived included), for the shard. */
  projectIds: readonly string[];
  /** The open project, if any — the fallback target for a project-scoped layout. */
  currentProject: string | null;
}

/**
 * Loading a saved layout, as a pure snapshot transformation (SPEC §11
 * Layouts) — shared by the workspace bridge and the dashboard fallback. The
 * saved tree is pruned against the live session set first (untitled tabs are
 * worktree-agnostic and always keep). When the layout's scope disagrees with
 * the snapshot's `layout_mode`, the load performs the mode transition ITSELF
 * — the caller flips the client setting to the returned `projectBased` AFTER
 * applying the patch, so the one-shot union/split conversion finds the
 * snapshot already converted and cannot overwrite the layout being loaded:
 *
 *  - profile-scoped under project mode: the loaded tree becomes the top-level
 *    layout and the stored per-project slices stay untouched (no union — but
 *    nothing is erased either);
 *  - project-scoped under profile mode: the current profile tree shards into
 *    the other projects as the setting flip would have done, existing slices
 *    win over their shard, and the target project takes the loaded layout
 *    instead of a shard.
 */
export function loadLayoutPatch(
  snap: UiStateSnapshot,
  saved: SavedLayout,
  ctx: LoadLayoutContext,
): { patch: Partial<UiStateSnapshot>; projectBased: boolean } {
  const keep = (ref: TabRef) => {
    const sid = tabSession(ref);
    return sid === UNTITLED_SESSION || ctx.alive.has(sid);
  };
  const tree = saved.layout_tree ? pruneTabs(saved.layout_tree, keep) : null;
  const active =
    saved.active_session !== null && ctx.alive.has(saved.active_session)
      ? saved.active_session
      : null;

  if (saved.scope === 'profile') {
    return {
      projectBased: false,
      patch: {
        layout_mode: 'profile',
        layout_tree: tree,
        active_session: active,
        layout_ref: saved.id,
      },
    };
  }

  // The store enforces project scope ⇒ project_id; the fallbacks are for
  // malformed rows only.
  const target = saved.project_id ?? ctx.currentProject ?? ctx.projectIds[0] ?? '';
  const slice: ProjectLayout = { layout_tree: tree, active_session: active, layout_ref: saved.id };
  if ((snap.layout_mode ?? 'profile') === 'project') {
    return {
      projectBased: true,
      patch: { project_layouts: { ...snap.project_layouts, [target]: slice } },
    };
  }
  const patch = splitToProjects(snap, ctx.projectIds, ctx.sessionProject, target);
  return {
    projectBased: true,
    patch: {
      ...patch,
      project_layouts: mergeShardedLayouts(patch.project_layouts ?? {}, snap.project_layouts, {
        [target]: slice,
      }),
    },
  };
}

/**
 * The project → profile transition: union every slice back into one tree
 * (structures side by side, tabs deduplicated — `joinTrees`), ordered with the
 * given project order first (the current project leads it) and any unlisted
 * slices after. The bound session is the first slice's, falling back through
 * the order. Clears the slices: each transition re-derives from scratch.
 */
export function unionToProfile(
  snap: UiStateSnapshot,
  orderedProjectIds: readonly string[],
): Partial<UiStateSnapshot> {
  const record = snap.project_layouts;
  const order = [
    ...orderedProjectIds.filter((id) => id in record),
    ...Object.keys(record).filter((id) => !orderedProjectIds.includes(id)),
  ];
  const slices = order.map((id) => record[id]!);
  return {
    layout_mode: 'profile',
    project_layouts: {},
    layout_tree: joinTrees(slices.map((s) => s.layout_tree).filter((t) => t !== null)),
    active_session: slices.map((s) => s.active_session).find((s) => s !== null) ?? null,
    // The union is a merged derivation — no single saved layout names it.
    layout_ref: null,
  };
}
