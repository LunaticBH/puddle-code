import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CompilationMode, LayoutLeaf, LayoutNode, TabRef } from '@puddle/shared';
import { tabKind, type EditorTab, type EditorView } from '../../editor/tabs/editor-tabs';
import type { UiStateHandle } from '../use-ui-state';
import {
  addTabToLeaf,
  addBackgroundTabToLeaf,
  allLeaves,
  boundToLiveSession,
  buildInitialTree,
  closeTab,
  dedupeIds,
  dropTab,
  findLeaf,
  flattenTabs,
  focusTab,
  leafContainingKey,
  linkableTarget,
  makeLeaf,
  openPreview,
  promoteTab,
  pruneTabs,
  renameBufferTabs,
  resizeSplit,
  setCompileMode,
  retargetFollowingTabs,
  sourceTabLocation,
  setTabView,
  tabRefKey,
  updateTabInLeaf,
  type DropSpec,
} from './layout-tree';

/**
 * The tiling layout controller (SPEC §8): owns the `layout_tree`, the focused
 * leaf, and the composite operations Workspace drives (open a file, activate/
 * close a tab, ensure/remove a terminal, prune dead sessions, resize). The tree
 * in `ui_state` is the single source of truth for what is open and where;
 * persistence rides the existing debounced ui-state path. Legacy snapshots
 * (`layout_tree === null`) migrate once via `buildInitialTree`.
 */
export interface LayoutController {
  tree: LayoutNode;
  focusedLeaf: LayoutLeaf;
  /** The focused leaf's active tab, when it is an editor — for the sidebar highlight. */
  activeEditorTab: EditorTab | null;
  focusLeaf(leafId: string): void;
  activate(leafId: string, ref: TabRef): void;
  close(leafId: string, ref: TabRef): void;
  /** `preview` opens an ephemeral tab (single-click); otherwise a permanent one. */
  openEditor(tab: EditorTab, opts?: { preview?: boolean }): void;
  /** Open permanently in a named pane, optionally focusing an existing tree-wide copy. */
  openEditorInLeaf(
    leafId: string,
    tab: EditorTab,
    opts?: { dedupeAcrossTree?: boolean; activate?: boolean },
  ): string;
  /** Persist one provider-backed source's mode across every duplicate tab. */
  setCompileMode(tab: EditorTab, mode: CompilationMode): void;
  ensureTerminal(session: string, opts?: { preview?: boolean }): void;
  /** Promote a preview tab to permanent (double-click), wherever it lives. */
  promote(ref: TabRef): void;
  /**
   * Set ONE pane's editor tab to Monaco source, rendered preview, or the
   * linked or scroll-locked follow-along preview (SPEC §8) — per tab, so the
   * same file can be source in one pane and preview in another.
   */
  setView(leafId: string, ref: TabRef, view: EditorView): void;
  /** Focus/create the ordinary source tab associated with a following preview. */
  revealSource(followerLeafId: string, target: EditorTab): string;
  /** Retarget every live view of a file after its on-disk path changes. */
  renameFile(source: EditorTab, nextPath: string): void;
  removeTerminal(session: string): void;
  pruneSessions(alive: ReadonlySet<string>): void;
  resize(splitId: string, sizes: number[]): void;
  drop(spec: DropSpec): void;
}

function sameFollowingTarget(left: EditorTab, right: EditorTab): boolean {
  return (
    left.session === right.session &&
    left.path === right.path &&
    (left.root ?? '') === (right.root ?? '') &&
    tabKind(left) === tabKind(right)
  );
}

/**
 * @param scopeKey identifies WHICH tree the handle exposes (the profile-wide
 * one, or one project's slice under project-based layout — SPEC §11). When it
 * changes, the cached migration tree resets: a null `layout_tree` must rebuild
 * against the new scope's snapshot, not reuse a tree built for the old one.
 */
export function useLayoutTree(uiState: UiStateHandle, scopeKey = 'profile'): LayoutController {
  const snapshot = uiState.snapshot;

  // Compute the migration tree at most once (stable ids) until it is persisted.
  const initialRef = useRef<LayoutNode | null>(null);
  const followingSourceRef = useRef<{ leafId: string; target: EditorTab } | null>(null);
  const scopeRef = useRef(scopeKey);
  const migrated = useRef(false);
  if (scopeRef.current !== scopeKey) {
    scopeRef.current = scopeKey;
    initialRef.current = null;
    followingSourceRef.current = null;
    migrated.current = false;
  }
  if (!snapshot.layout_tree && !initialRef.current) {
    initialRef.current = buildInitialTree(snapshot);
  }
  const storedTree = snapshot.layout_tree ?? initialRef.current ?? makeLeaf([]);
  // Every rendered tree passes through here, so this is where a snapshot with
  // REPEATED node ids is healed — a build before this fix unioned project-based
  // slices that all carried the sharded tree's ids, and the renderer cannot
  // survive two panes under one id (layout-tree's "Node identity"). `dedupeIds`
  // returns the same object when the ids are already unique, so the memo keeps
  // tree identity stable for the healthy case; the effect below writes the
  // repair back once, and the repaired snapshot then heals nothing further.
  const tree = useMemo(() => dedupeIds(storedTree), [storedTree]);

  const persist = useCallback(
    (next: LayoutNode) => uiState.update({ layout_tree: next }),
    [uiState],
  );

  // Persist the migrated tree once, when loaded, so its ids stabilise in storage.
  // This MUST be single-shot and never fire once a tree exists: `persist` changes
  // identity every render, so keying the effect on it re-ran this constantly, and
  // a stale run could overwrite `layout_tree` with the EMPTY migration tree AFTER
  // the user's first open — dropping the just-opened tab/terminal (only on a fresh
  // project, where `layout_tree` starts null; a reload then hid it). The `migrated`
  // ref makes it fire exactly once, the `!snapshot.layout_tree` guard yields to a
  // concurrent open, and `persistRef` keeps the churny `persist` out of the deps.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    if (migrated.current) return;
    if (uiState.loaded && !snapshot.layout_tree && initialRef.current) {
      migrated.current = true;
      // Only persist a NON-EMPTY migrated tree. A fresh project's initial tree is
      // an empty leaf — it has nothing to stabilise, and persisting it is exactly
      // what raced and clobbered the first open. A legacy snapshot with tabs is
      // persisted once (on load, before any open).
      if (flattenTabs(initialRef.current).length > 0) persistRef.current(initialRef.current);
    }
  }, [uiState.loaded, snapshot.layout_tree]);

  // Write a healed tree back, so the repair outlives this render. Keyed on the
  // two identities: once the persisted snapshot arrives, `tree === storedTree`
  // and this stops firing.
  useEffect(() => {
    if (uiState.loaded && tree !== storedTree && snapshot.layout_tree) {
      persistRef.current(tree);
    }
  }, [uiState.loaded, tree, storedTree, snapshot.layout_tree]);

  const [focusedLeafId, setFocusedLeafId] = useState<string | null>(null);
  const focusedLeaf =
    (focusedLeafId ? findLeaf(tree, focusedLeafId) : null) ?? allLeaves(tree)[0] ?? makeLeaf([]);

  const activeRef = focusedLeaf.tabs.find((t) => tabRefKey(t) === focusedLeaf.activeKey) ?? null;
  const activeEditorTab = activeRef?.type === 'editor' ? activeRef.tab : null;
  const rememberLinkable = (leafId: string, ref: TabRef) => {
    const target = linkableTarget(ref);
    if (target) followingSourceRef.current = { leafId, target };
  };

  return useMemo<LayoutController>(
    () => ({
      tree,
      focusedLeaf,
      activeEditorTab,
      focusLeaf: (leafId) => setFocusedLeafId(leafId),
      // Activations feed the following slots (SPEC §8): whatever renderable tab
      // an op just made active is what every linked/locked preview in this tree
      // retargets to, in the SAME persist, so all of them move together.
      activate: (leafId, ref) => {
        setFocusedLeafId(leafId);
        rememberLinkable(leafId, ref);
        const key = tabRefKey(ref);
        const leaf = findLeaf(tree, leafId);
        const alreadyActive = leaf?.activeKey === key;
        const focused = alreadyActive ? tree : focusTab(tree, leafId, key);
        const next = retargetFollowingTabs(focused, ref);
        // Already active and nothing to retarget (a pane-body click on the
        // shown tab, mostly) — no tree change, no persist.
        if (alreadyActive && next === tree) return;
        persist(next);
      },
      close: (leafId, ref) => {
        // Closing hands the leaf to a neighbour tab, and "most recently
        // active" means it: a markdown tab surfacing under a closed one
        // retargets the following slots too.
        const next = closeTab(tree, leafId, tabRefKey(ref));
        const leaf = findLeaf(next, leafId);
        const surfaced = leaf?.tabs.find((t) => tabRefKey(t) === leaf.activeKey);
        if (surfaced) rememberLinkable(leafId, surfaced);
        persist(surfaced ? retargetFollowingTabs(next, surfaced) : next);
      },
      openEditor: (tab, opts) => {
        const target = focusedLeaf.id;
        setFocusedLeafId(target);
        const ref: TabRef = { type: 'editor', tab };
        rememberLinkable(target, ref);
        const opened = opts?.preview
          ? openPreview(tree, target, ref)
          : addTabToLeaf(tree, target, ref);
        persist(retargetFollowingTabs(opened, ref));
      },
      openEditorInLeaf: (leafId, tab, opts) => {
        const ref: TabRef = { type: 'editor', tab };
        const key = tabRefKey(ref);
        const activate = opts?.activate ?? true;
        const existing = opts?.dedupeAcrossTree ? leafContainingKey(tree, key) : null;
        if (existing) {
          let next = updateTabInLeaf(tree, existing.id, ref);
          if (activate) {
            setFocusedLeafId(existing.id);
            next = focusTab(next, existing.id, key);
          }
          if (existing.previewKey === key) next = promoteTab(next, key);
          if (next !== tree) persist(next);
          return existing.id;
        }

        const target = findLeaf(tree, leafId)?.id ?? focusedLeaf.id;
        if (activate) {
          setFocusedLeafId(target);
          rememberLinkable(target, ref);
          persist(retargetFollowingTabs(addTabToLeaf(tree, target, ref), ref));
        } else {
          persist(addBackgroundTabToLeaf(tree, target, ref));
        }
        return target;
      },
      setCompileMode: (tab, mode) => {
        const next = setCompileMode(tree, tab, mode);
        if (next !== tree) persist(next);
      },
      ensureTerminal: (session, opts) => {
        const key = `term:${session}`;
        const existing = leafContainingKey(tree, key);
        if (existing) {
          setFocusedLeafId(existing.id);
          const needsFocus = existing.activeKey !== key;
          // A PERMANENT ensure promotes an existing preview tab — double-click
          // on a sidebar session pins it, exactly like double-click on a file.
          const needsPromote = !opts?.preview && existing.previewKey === key;
          if (needsFocus || needsPromote) {
            let next = tree;
            if (needsFocus) next = focusTab(next, existing.id, key);
            if (needsPromote) next = promoteTab(next, key);
            persist(next);
          }
        } else {
          const target = focusedLeaf.id;
          setFocusedLeafId(target);
          const ref: TabRef = { type: 'terminal', session };
          persist(opts?.preview ? openPreview(tree, target, ref) : addTabToLeaf(tree, target, ref));
        }
      },
      promote: (ref) => persist(promoteTab(tree, tabRefKey(ref))),
      setView: (leafId, ref, view) => {
        // Remember the ordinary tab before entering a constant-key follower.
        rememberLinkable(leafId, ref);
        const viewed = setTabView(tree, leafId, tabRefKey(ref), view);
        const leaf = findLeaf(viewed, leafId);
        const active = leaf?.tabs.find((tab) => tabRefKey(tab) === leaf.activeKey);
        persist(active ? retargetFollowingTabs(viewed, active) : viewed);
      },
      revealSource: (followerLeafId, target) => {
        const remembered = followingSourceRef.current;
        const rememberedForTarget =
          remembered && sameFollowingTarget(remembered.target, target) ? remembered : null;
        const preferredLeafId =
          rememberedForTarget && sourceTabLocation(tree, target, rememberedForTarget.leafId)
            ? rememberedForTarget.leafId
            : undefined;
        const location = sourceTabLocation(tree, target, preferredLeafId);
        if (location) {
          setFocusedLeafId(location.leafId);
          let next = setTabView(tree, location.leafId, tabRefKey(location.ref), 'source');
          next = focusTab(next, location.leafId, tabRefKey(location.ref));
          followingSourceRef.current = { leafId: location.leafId, target };
          if (next !== tree) persist(next);
          return location.leafId;
        }

        const rememberedLeaf = rememberedForTarget
          ? findLeaf(tree, rememberedForTarget.leafId)
          : null;
        const targetLeafId =
          rememberedLeaf?.id ?? findLeaf(tree, followerLeafId)?.id ?? focusedLeaf.id;
        const sourceRef: TabRef = {
          type: 'editor',
          tab: {
            session: target.session,
            path: target.path,
            ...(target.kind !== undefined ? { kind: target.kind } : {}),
            ...(target.root !== undefined ? { root: target.root } : {}),
            view: 'source',
          },
        };
        setFocusedLeafId(targetLeafId);
        followingSourceRef.current = { leafId: targetLeafId, target };
        persist(addTabToLeaf(tree, targetLeafId, sourceRef));
        return targetLeafId;
      },
      renameFile: (source, nextPath) => {
        const next = renameBufferTabs(tree, source, nextPath);
        if (next !== tree) persist(next);
      },
      removeTerminal: (session) => {
        const leaf = leafContainingKey(tree, `term:${session}`);
        if (leaf) persist(closeTab(tree, leaf.id, `term:${session}`));
      },
      // Session-less tabs (untitled drafts, directory targets) survive: the nil
      // uuid names no session, so no session of theirs can have died.
      pruneSessions: (alive) => persist(pruneTabs(tree, boundToLiveSession(alive))),
      resize: (splitId, sizes) => persist(resizeSplit(tree, splitId, sizes)),
      drop: (spec) => {
        setFocusedLeafId(spec.toLeafId);
        rememberLinkable(spec.toLeafId, spec.ref);
        persist(retargetFollowingTabs(dropTab(tree, spec), spec.ref));
      },
    }),
    [tree, focusedLeaf, activeEditorTab, persist],
  );
}
