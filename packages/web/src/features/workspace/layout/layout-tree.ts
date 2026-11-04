import { UNTITLED_SESSION } from '@puddle/shared';
import type {
  CompilationMode,
  LayoutLeaf,
  LayoutNode,
  LayoutSplit,
  TabRef,
  UiStateSnapshot,
} from '@puddle/shared';
import { tabKey, tabKind, type EditorTab, type EditorView } from '../../editor/tabs/editor-tabs';
import { previewKind } from '../../editor/previews/preview-kind';

/**
 * Pure, React/Monaco-free reducer for the tiling layout tree (SPEC §8) — the
 * analogue of `editor-tabs.ts`/`panel-layout.ts`, unit-tested under vitest. Every
 * op returns a NEW tree and runs `normalise`, which enforces the structural
 * invariants (single-child splits collapse, empty leaves drop except the sole
 * root, sizes track children, same-direction splits flatten, `activeKey` stays
 * valid). Node ids are stable across ops — only newly created nodes get fresh ids.
 */

export type DropEdge = 'top' | 'bottom' | 'left' | 'right' | 'center';

function newId(): string {
  return crypto.randomUUID();
}

// ---- Tab identity ---------------------------------------------------------

/** Stable key for a tab, unique across editors and terminals (registry + React keys + dedupe). */
export function tabRefKey(ref: TabRef): string {
  return ref.type === 'terminal' ? `term:${ref.session}` : `editor:${tabKey(ref.tab as EditorTab)}`;
}

export function sameRef(a: TabRef, b: TabRef): boolean {
  return tabRefKey(a) === tabRefKey(b);
}

function isTerminal(ref: TabRef): boolean {
  return ref.type === 'terminal';
}

/** A stable following preview slot (SPEC §8): linked or scroll-locked. */
export function isFollowing(ref: TabRef): boolean {
  return ref.type === 'editor' && (ref.tab.view === 'linked' || ref.tab.view === 'locked');
}

// ---- Constructors ---------------------------------------------------------

export function makeLeaf(tabs: TabRef[] = [], activeKey?: string | null): LayoutLeaf {
  const keys = tabs.map(tabRefKey);
  const active =
    activeKey && keys.includes(activeKey) ? activeKey : keys.length > 0 ? keys[0]! : null;
  // previewKey is null by default (matches the schema default, so a built tree
  // round-trips through uiStateSnapshotSchema unchanged).
  return { kind: 'leaf', id: newId(), tabs, activeKey: active, previewKey: null };
}

function makeSplit(
  direction: 'row' | 'col',
  children: LayoutNode[],
  sizes?: number[],
): LayoutSplit {
  return {
    kind: 'split',
    id: newId(),
    direction,
    children,
    sizes: sizes ?? children.map(() => 100 / Math.max(1, children.length)),
  };
}

// ---- Traversal ------------------------------------------------------------

export function findLeaf(node: LayoutNode, leafId: string): LayoutLeaf | null {
  if (node.kind === 'leaf') return node.id === leafId ? node : null;
  for (const child of node.children) {
    const found = findLeaf(child, leafId);
    if (found) return found;
  }
  return null;
}

export function leafContainingKey(node: LayoutNode, key: string): LayoutLeaf | null {
  if (node.kind === 'leaf') return node.tabs.some((t) => tabRefKey(t) === key) ? node : null;
  for (const child of node.children) {
    const found = leafContainingKey(child, key);
    if (found) return found;
  }
  return null;
}

/** Every leaf, left-to-right / top-to-bottom. */
export function allLeaves(node: LayoutNode): LayoutLeaf[] {
  if (node.kind === 'leaf') return [node];
  return node.children.flatMap(allLeaves);
}

/** Every tab across the whole tree in DFS order (feeds the keep-alive registry + model refcount). */
export function flattenTabs(node: LayoutNode): TabRef[] {
  return allLeaves(node).flatMap((leaf) => leaf.tabs);
}

// ---- Node identity --------------------------------------------------------

/**
 * Node ids must be unique WITHIN a tree. They are the tiling area's React keys
 * and its resizable-panel ids, and every op addresses a pane by id, so two
 * nodes sharing one id alias each other: `findLeaf`/`transformLeaf` reach only
 * the first (closing a tab in one pane closes it in its twin), a `Group`'s
 * `defaultLayout` collapses their entries into a single key and silently drops
 * the pane sizes, and React gets two siblings under one key — which took the
 * whole workspace down. Copying a tree (project-based layout shards ONE tree
 * into a slice per project, SPEC §11) must therefore re-id the copies, or the
 * union that puts the slices back side by side collides with itself.
 */

/** Every node id in the tree, DFS, splits and leaves alike. */
function nodeIds(node: LayoutNode): string[] {
  return node.kind === 'leaf' ? [node.id] : [node.id, ...node.children.flatMap(nodeIds)];
}

/** True when a node id repeats anywhere in the tree. */
export function hasDuplicateIds(node: LayoutNode): boolean {
  const ids = nodeIds(node);
  return new Set(ids).size !== ids.length;
}

/** A structurally identical copy that shares no node id with the original. */
export function reidNodes(node: LayoutNode): LayoutNode {
  return node.kind === 'leaf'
    ? { ...node, id: newId() }
    : { ...node, id: newId(), children: node.children.map(reidNodes) };
}

/**
 * Heal repeated ids: the first occurrence keeps its id, every later one gets a
 * fresh one. Returns the tree UNCHANGED (same object) when the ids are already
 * unique, so it is safe to run on every load — which is how a snapshot written
 * by a build that unioned colliding slices repairs itself.
 */
export function dedupeIds(node: LayoutNode): LayoutNode {
  if (!hasDuplicateIds(node)) return node;
  const seen = new Set<string>();
  const walk = (n: LayoutNode): LayoutNode => {
    const id = seen.has(n.id) ? newId() : n.id;
    seen.add(id);
    return n.kind === 'leaf' ? { ...n, id } : { ...n, id, children: n.children.map(walk) };
  };
  return walk(node);
}

// ---- Normalisation --------------------------------------------------------

function normaliseLeaf(leaf: LayoutLeaf): LayoutLeaf {
  const keys = leaf.tabs.map(tabRefKey);
  const activeKey =
    leaf.activeKey && keys.includes(leaf.activeKey) ? leaf.activeKey : (keys[0] ?? null);
  // A preview tab that has been closed or moved away stops being a preview.
  const previewKey = leaf.previewKey && keys.includes(leaf.previewKey) ? leaf.previewKey : null;
  if (activeKey === leaf.activeKey && previewKey === (leaf.previewKey ?? null)) return leaf;
  return { ...leaf, activeKey, previewKey };
}

/**
 * Enforce the tree invariants bottom-up: normalise children first, flatten any
 * same-direction child split (distributing its parent size across its children
 * by their internal ratios), drop empty leaves, then collapse a single-child
 * split to that child. A split that loses all children becomes a fresh empty
 * leaf; a top-level empty leaf is preserved (the empty-workspace state).
 */
export function normalise(node: LayoutNode): LayoutNode {
  if (node.kind === 'leaf') return normaliseLeaf(node);

  const normChildren = node.children.map(normalise);

  // Flatten same-direction splits.
  const flatChildren: LayoutNode[] = [];
  const flatSizes: number[] = [];
  normChildren.forEach((child, i) => {
    const size = node.sizes[i] ?? 1;
    if (child.kind === 'split' && child.direction === node.direction) {
      const inner = child.sizes.reduce((a, b) => a + b, 0) || child.children.length;
      child.children.forEach((gc, j) => {
        flatChildren.push(gc);
        flatSizes.push((size * (child.sizes[j] ?? 1)) / inner);
      });
    } else {
      flatChildren.push(child);
      flatSizes.push(size);
    }
  });

  // Drop empty leaves.
  const keptChildren: LayoutNode[] = [];
  const keptSizes: number[] = [];
  flatChildren.forEach((child, i) => {
    if (child.kind === 'leaf' && child.tabs.length === 0) return;
    keptChildren.push(child);
    keptSizes.push(flatSizes[i] ?? 1);
  });

  if (keptChildren.length === 0) return makeLeaf([]);
  if (keptChildren.length === 1) return keptChildren[0]!;
  return { ...node, children: keptChildren, sizes: keptSizes };
}

// ---- Structural edits -----------------------------------------------------

/** Replace the leaf `leafId` with `fn(leaf)` wherever it sits; identity elsewhere. */
function transformLeaf(
  node: LayoutNode,
  leafId: string,
  fn: (leaf: LayoutLeaf) => LayoutNode,
): LayoutNode {
  if (node.kind === 'leaf') return node.id === leafId ? fn(node) : node;
  return { ...node, children: node.children.map((c) => transformLeaf(c, leafId, fn)) };
}

/**
 * Remove the tab `key` from ONE leaf (a move's first half). Scoped to the
 * source leaf on purpose: the same file may legitimately sit in several panes
 * (sidebar copy-drops, 2026-08-06), and those are independent tabs — moving
 * one must not vacuum up its siblings. Terminals are unique tree-wide anyway,
 * so for them the source leaf IS every leaf that holds the key.
 */
function removeKeyFromLeaf(node: LayoutNode, leafId: string, key: string): LayoutNode {
  return transformLeaf(node, leafId, (leaf) => {
    if (!leaf.tabs.some((t) => tabRefKey(t) === key)) return leaf;
    const tabs = leaf.tabs.filter((t) => tabRefKey(t) !== key);
    const activeKey = leaf.activeKey === key ? neighbourKey(leaf, key) : leaf.activeKey;
    return { ...leaf, tabs, activeKey };
  });
}

/** The tab to activate after `key` leaves a leaf: right neighbour, else left, else null. */
function neighbourKey(leaf: LayoutLeaf, key: string): string | null {
  const idx = leaf.tabs.findIndex((t) => tabRefKey(t) === key);
  if (idx === -1) return leaf.activeKey;
  const remaining = leaf.tabs.filter((t) => tabRefKey(t) !== key);
  if (remaining.length === 0) return null;
  return tabRefKey(remaining[Math.min(idx, remaining.length - 1)]!);
}

function insertInLeaf(leaf: LayoutLeaf, ref: TabRef, index?: number): LayoutLeaf {
  const without = leaf.tabs.filter((t) => !sameRef(t, ref));
  const at = index === undefined ? without.length : Math.max(0, Math.min(index, without.length));
  const tabs = [...without.slice(0, at), ref, ...without.slice(at)];
  return { ...leaf, tabs, activeKey: tabRefKey(ref) };
}

/** Split `leafId` along `edge`, placing `ref` in the new sibling leaf. */
export function splitLeaf(
  tree: LayoutNode,
  leafId: string,
  edge: Exclude<DropEdge, 'center'>,
  ref: TabRef,
): LayoutNode {
  const direction = edge === 'left' || edge === 'right' ? 'row' : 'col';
  const before = edge === 'left' || edge === 'top';
  const next = transformLeaf(tree, leafId, (leaf) => {
    const fresh = makeLeaf([ref]);
    const children = before ? [fresh, leaf] : [leaf, fresh];
    return makeSplit(direction, children, [50, 50]);
  });
  return normalise(next);
}

export interface DropSpec {
  ref: TabRef;
  /** The leaf the tab was dragged from — a move removes the key from THIS leaf only. */
  fromLeafId: string;
  toLeafId: string;
  edge: DropEdge;
  /**
   * Insertion index for a `center` drop (strip reorder), counted in the target
   * strip's VISIBLE order — including the dragged tab itself when it is already
   * in that leaf (dropTab compensates). Appended when absent.
   */
  index?: number;
  /**
   * An OPEN rather than a move (sidebar drags — decision 2026-08-06): the tab
   * lands in the target without leaving any pane it already occupies, so the
   * same file can sit in two panes at once (both tabs share one refcounted
   * buffer). Within ONE pane a tab stays unique — a copy-drop into a pane
   * already holding it repositions/focuses instead of duplicating. Editor tabs
   * only: a terminal is one live PTY whose DOM exists once (keep-alive), so it
   * always moves and the flag is ignored.
   */
  copy?: boolean;
}

/**
 * The single drag-drop entry point. A STRIP drop moves THAT tab — out of its
 * source pane, into the target — leaving nothing behind in the source; a copy
 * of the same file in some other pane is an independent tab and stays put. A
 * SIDEBAR drop (`copy`) opens instead: the file tree names content, not a
 * pane, so dropping an already-open file grows a second tab of it rather than
 * yanking the first out of the pane it lives in — which also makes the
 * same-file split possible (edge-drop a pane's only file onto its own edge).
 * `center` inserts into the target leaf at `index`; an edge splits it. A drop
 * also PINS the tab: deliberately placing a preview tab promotes it, as in
 * VSCode.
 */
export function dropTab(tree: LayoutNode, spec: DropSpec): LayoutNode {
  const { ref, toLeafId, edge } = spec;
  const key = tabRefKey(ref);
  const copy = spec.copy === true && !isTerminal(ref);
  // `index` counts the target strip as the user sees it — the dragged tab is
  // still in place while dragging. Removing it first shifts every later
  // position left by one, so compensate before the move.
  let index = spec.index;
  if (edge === 'center' && index !== undefined) {
    const current = findLeaf(tree, toLeafId)?.tabs.findIndex((t) => tabRefKey(t) === key) ?? -1;
    if (current !== -1 && current < index) index -= 1;
  }
  const withoutSource = copy ? tree : removeKeyFromLeaf(tree, spec.fromLeafId, key);

  // The target leaf may have been pruned if it emptied during the move (dragging
  // a lone tab onto its own leaf's edge) — normalise at the end restores sanity.
  if (edge === 'center') {
    const next = transformLeaf(withoutSource, toLeafId, (leaf) => insertInLeaf(leaf, ref, index));
    // If the target leaf vanished (moved its only tab), re-seed it.
    if (!findLeaf(next, toLeafId) && !leafContainingKey(next, key)) {
      return promoteTab(normalise(appendToFirstLeaf(next, ref)), key);
    }
    return promoteTab(normalise(next), key);
  }
  if (!findLeaf(withoutSource, toLeafId)) {
    // Target leaf was the source and emptied; the ref becomes the whole content.
    return normalise(makeLeaf([ref]));
  }
  return promoteTab(splitLeaf(withoutSource, toLeafId, edge, ref), key);
}

function appendToFirstLeaf(node: LayoutNode, ref: TabRef): LayoutNode {
  const first = allLeaves(node)[0];
  if (!first) return makeLeaf([ref]);
  return transformLeaf(node, first.id, (leaf) => insertInLeaf(leaf, ref));
}

/** Move a tab to `toLeafId` at `index` (strip reorder within/between leaves — no split). */
export function moveTab(
  tree: LayoutNode,
  ref: TabRef,
  fromLeafId: string,
  toLeafId: string,
  index?: number,
): LayoutNode {
  return dropTab(tree, { ref, fromLeafId, toLeafId, edge: 'center', index });
}

/** Close the tab `key` from leaf `leafId` (activating its neighbour); drops the leaf if it empties. */
export function closeTab(tree: LayoutNode, leafId: string, key: string): LayoutNode {
  const next = transformLeaf(tree, leafId, (leaf) => {
    if (!leaf.tabs.some((t) => tabRefKey(t) === key)) return leaf;
    return {
      ...leaf,
      tabs: leaf.tabs.filter((t) => tabRefKey(t) !== key),
      activeKey: leaf.activeKey === key ? neighbourKey(leaf, key) : leaf.activeKey,
    };
  });
  return normalise(next);
}

/**
 * Add `ref` to leaf `leafId` and activate it — appending if absent, else just
 * focusing it (add-or-focus, no duplicate within a leaf). Used to open a file
 * or terminal into a specific pane PERMANENTLY: if `ref` was this leaf's preview
 * tab, opening it permanently promotes it (clears `previewKey`).
 */
export function addTabToLeaf(tree: LayoutNode, leafId: string, ref: TabRef): LayoutNode {
  const key = tabRefKey(ref);
  const next = transformLeaf(tree, leafId, (leaf) => {
    const previewKey = leaf.previewKey === key ? null : leaf.previewKey;
    if (leaf.tabs.some((t) => sameRef(t, ref))) return { ...leaf, activeKey: key, previewKey };
    return { ...leaf, tabs: [...leaf.tabs, ref], activeKey: key, previewKey };
  });
  return normalise(next);
}

/** Append a permanent tab without changing which tab or pane the user is working in. */
export function addBackgroundTabToLeaf(tree: LayoutNode, leafId: string, ref: TabRef): LayoutNode {
  const key = tabRefKey(ref);
  const next = transformLeaf(tree, leafId, (leaf) => {
    if (leaf.tabs.some((candidate) => tabRefKey(candidate) === key)) {
      return {
        ...leaf,
        tabs: leaf.tabs.map((candidate) => (tabRefKey(candidate) === key ? ref : candidate)),
        previewKey: leaf.previewKey === key ? null : leaf.previewKey,
      };
    }
    return { ...leaf, tabs: [...leaf.tabs, ref] };
  });
  return normalise(next);
}

/** Replace one existing tab's metadata without changing its stable identity or position. */
export function updateTabInLeaf(tree: LayoutNode, leafId: string, ref: TabRef): LayoutNode {
  const key = tabRefKey(ref);
  return transformLeaf(tree, leafId, (leaf) => ({
    ...leaf,
    tabs: leaf.tabs.map((candidate) => (tabRefKey(candidate) === key ? ref : candidate)),
  })) as LayoutNode;
}

/** Keep a source's compile mode consistent across duplicate views in every pane. */
export function setCompileMode(
  tree: LayoutNode,
  target: EditorTab,
  mode: CompilationMode,
): LayoutNode {
  const key = tabKey(target);
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'split') return { ...node, children: node.children.map(walk) };
    return {
      ...node,
      tabs: node.tabs.map((ref) =>
        ref.type === 'editor' && tabKey(ref.tab as EditorTab) === key
          ? { ...ref, tab: { ...ref.tab, compile_mode: mode } }
          : ref,
      ),
    };
  };
  return walk(tree);
}

/**
 * Open `ref` as leaf `leafId`'s ephemeral PREVIEW tab (VSCode single-click). If
 * `ref` is already open it is just focused (its permanent/preview state stays);
 * otherwise it replaces the leaf's current preview tab IN PLACE — so a run of
 * single-clicks reuses one slot — and becomes the new preview + active tab.
 *
 * Exception: a preview TERMINAL is a live PTY, so it is never silently discarded
 * — instead it is PINNED (promoted) and the new tab opens alongside it. That
 * keeps an agent terminal you were watching from vanishing when you peek at a
 * file, and avoids the dead-end where re-clicking that session (same URL) would
 * not re-open a tab the effect never re-runs for.
 *
 * A LINKED slot in the preview position gets the same protection: it is a
 * deliberately-kept viewing surface (SPEC §8), and single-clicking a file
 * must retarget it — which the open's caller does — not destroy it.
 */
/**
 * A preview slot showing a RENDERED view stays rendered (decision 2026-08-05):
 * the tab replacing it inherits `view: 'preview'` when it too can be rendered.
 * Skimming a directory of markdown by single-clicking each file is the gesture
 * this exists for — without it every file arrived as source and had to be
 * toggled, one tab at a time, which is not skimming.
 *
 * A view the caller ASKED for wins (a ⌘-clicked link from inside a preview names
 * its own), and a file with no rendered view inherits nothing.
 */
function inheritView(outgoing: TabRef, incoming: TabRef): TabRef {
  if (outgoing.type !== 'editor' || incoming.type !== 'editor') return incoming;
  if (outgoing.tab.view !== 'preview' || incoming.tab.view !== undefined) return incoming;
  if (previewKind(incoming.tab.path) === null) return incoming;
  return { ...incoming, tab: { ...incoming.tab, view: 'preview' } };
}

export function openPreview(tree: LayoutNode, leafId: string, ref: TabRef): LayoutNode {
  const key = tabRefKey(ref);
  const next = transformLeaf(tree, leafId, (leaf) => {
    if (leaf.tabs.some((t) => sameRef(t, ref))) return { ...leaf, activeKey: key };
    const idx = leaf.previewKey ? leaf.tabs.findIndex((t) => tabRefKey(t) === leaf.previewKey) : -1;
    const outgoing = idx >= 0 ? leaf.tabs[idx]! : undefined;
    const replaceInPlace =
      outgoing !== undefined && !isTerminal(outgoing) && !isFollowing(outgoing);
    // `view` is not part of tab identity, so the key is the incoming ref's
    // either way — only the tab object it names changes.
    const opened = replaceInPlace ? inheritView(outgoing, ref) : ref;
    const tabs = replaceInPlace
      ? leaf.tabs.map((t, i) => (i === idx ? opened : t))
      : [...leaf.tabs, opened];
    return { ...leaf, tabs, activeKey: key, previewKey: key };
  });
  return normalise(next);
}

/** Promote the tab `key` wherever it is the preview tab, making it permanent (double-click). */
export function promoteTab(tree: LayoutNode, key: string): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode =>
    node.kind === 'leaf'
      ? node.previewKey === key
        ? { ...node, previewKey: null }
        : node
      : { ...node, children: node.children.map(walk) };
  return walk(tree);
}

/**
 * Rewrite the editor tab `key` IN ONE LEAF with `view` (the source / preview /
 * following toggle, SPEC §8). Between `source` and `preview` the view is not part
 * of tab identity, so the key is unchanged and active/preview state is
 * untouched.
 *
 * Deliberately scoped to `leafId` (fixed 2026-08-04): the same file open in two
 * panes shares one key, so rewriting every match flipped both tabs at once and
 * source-beside-preview — the whole point of splitting a pane on a markdown file
 * — was impossible. A leaf holds at most one tab per key, so per-leaf IS
 * per-tab. The shared editor BUFFER is untouched by this: both tabs still show
 * the same text and the same unsaved edits, they just render it differently.
 *
 * Entering, leaving, or crossing between FOLLOWING modes is the exception:
 * linked and locked slots key as their constant mode (see `tabKey`), so the
 * leaf's `activeKey`/`previewKey` remap with the change. When another tab in
 * the leaf already owns the new key, the toggled tab DISSOLVES into that owner
 * rather than duplicating a key mid-render.
 */
export function setTabView(
  tree: LayoutNode,
  leafId: string,
  key: string,
  view: EditorView | undefined,
): LayoutNode {
  return transformLeaf(tree, leafId, (leaf) => {
    const idx = leaf.tabs.findIndex((t) => t.type === 'editor' && tabRefKey(t) === key);
    const cur = idx >= 0 ? leaf.tabs[idx]! : undefined;
    if (cur === undefined || cur.type !== 'editor') return leaf;
    const rewritten: TabRef = { ...cur, tab: { ...cur.tab, view } };
    const newKey = tabRefKey(rewritten);
    if (newKey === key) {
      return { ...leaf, tabs: leaf.tabs.map((t, i) => (i === idx ? rewritten : t)) };
    }
    const collided = leaf.tabs.some((t, i) => i !== idx && tabRefKey(t) === newKey);
    const tabs = collided
      ? leaf.tabs.filter((_, i) => i !== idx)
      : leaf.tabs.map((t, i) => (i === idx ? rewritten : t));
    return {
      ...leaf,
      tabs,
      activeKey: leaf.activeKey === key ? newKey : leaf.activeKey,
      // A dissolved slot's ephemerality dies with it — the surviving owner
      // keeps its own permanent/preview state.
      previewKey: leaf.previewKey === key ? (collided ? null : newKey) : (leaf.previewKey ?? null),
    };
  }) as LayoutNode;
}

/** Whether an editor tab points at the live buffer a filesystem rename moves. */
function sharesBuffer(tab: EditorTab, source: EditorTab): boolean {
  const kind = tabKind(tab);
  return (
    kind !== 'commit' &&
    kind !== 'untitled' &&
    tab.session === source.session &&
    tab.path === source.path &&
    tab.root === source.root
  );
}

/**
 * Retarget every open view of one live file after it is renamed on disk.
 *
 * File, diff, and following-preview tabs all share the same path-keyed buffer,
 * so changing only the chip that initiated the rename would leave the other
 * views pointing at a path that no longer exists. Commit tabs are historical
 * snapshots and deliberately stay on their committed path. Leaf pointers are
 * remapped because ordinary editor keys include the path; linked/locked keys
 * are constant and naturally remain unchanged.
 */
export function renameBufferTabs(
  tree: LayoutNode,
  source: EditorTab,
  nextPath: string,
): LayoutNode {
  if (nextPath === source.path) return tree;
  let changed = false;
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'split') {
      const children = node.children.map(walk);
      return children.some((child, index) => child !== node.children[index])
        ? { ...node, children }
        : node;
    }

    const keyMap = new Map<string, string>();
    let touched = false;
    const tabs = node.tabs.map((ref): TabRef => {
      if (ref.type !== 'editor' || !sharesBuffer(ref.tab as EditorTab, source)) return ref;
      const rewritten: TabRef = { ...ref, tab: { ...ref.tab, path: nextPath } };
      keyMap.set(tabRefKey(ref), tabRefKey(rewritten));
      touched = true;
      return rewritten;
    });
    if (!touched) return node;
    changed = true;
    const activeKey = node.activeKey;
    const previewKey = node.previewKey ?? null;
    return {
      ...node,
      tabs,
      activeKey: activeKey === null ? null : (keyMap.get(activeKey) ?? activeKey),
      previewKey: previewKey === null ? null : (keyMap.get(previewKey) ?? previewKey),
    };
  };

  const next = walk(tree);
  return changed ? next : tree;
}

/**
 * The tab an activation makes every following slot follow (SPEC §8): a plain
 * or external FILE tab with a rendered view available, and not itself a
 * follower — a follow-along surface must never chase another follower.
 * Terminals, diffs, commits, untitled drafts, and non-renderable files
 * retarget nothing.
 */
export function linkableTarget(ref: TabRef): EditorTab | null {
  if (ref.type !== 'editor') return null;
  const tab = ref.tab as EditorTab;
  const kind = tabKind(tab);
  if (kind !== 'file' && kind !== 'external') return null;
  if (tab.view === 'linked' || tab.view === 'locked') return null;
  if (previewKind(tab.path) === null) return null;
  return tab;
}

/**
 * Rewrite EVERY following slot in the tree to mirror the tab `ref` just made
 * active (SPEC §8) — linked and locked together, preserving each slot's mode.
 * A slot's key is its constant mode (see `tabKey`), so a retarget is a pure
 * field rewrite: no pointer moves, no structural change, and the layout
 * signature — deliberately — reads the same. When `ref` is not a linkable
 * target, or every slot already shows it, the SAME tree object comes back.
 *
 * Which activations reach here decides the scope: the controller calls this
 * on the LIVE tree only, so under a project-based layout each project's
 * slots follow that project's own activity, and under the profile-wide
 * layout the one shared tree follows everything (SPEC §11).
 */
export function retargetFollowingTabs(tree: LayoutNode, ref: TabRef): LayoutNode {
  const target = linkableTarget(ref);
  if (!target) return tree;
  let changed = false;
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'split') return { ...node, children: node.children.map(walk) };
    let touched = false;
    const tabs = node.tabs.map((t): TabRef => {
      if (t.type !== 'editor' || !isFollowing(t)) return t;
      const cur = t.tab as EditorTab;
      if (
        cur.session === target.session &&
        cur.path === target.path &&
        (cur.root ?? '') === (target.root ?? '') &&
        tabKind(cur) === tabKind(target)
      ) {
        return t;
      }
      touched = true;
      return {
        type: 'editor',
        tab: {
          session: target.session,
          path: target.path,
          ...(target.kind !== undefined ? { kind: target.kind } : {}),
          ...(target.root !== undefined ? { root: target.root } : {}),
          view: cur.view,
        },
      };
    });
    if (!touched) return node;
    changed = true;
    return { ...node, tabs };
  };
  const next = walk(tree);
  return changed ? next : tree;
}

export interface SourceTabLocation {
  leafId: string;
  ref: TabRef & { type: 'editor' };
}

function sameFollowingTarget(tab: EditorTab, target: EditorTab): boolean {
  return (
    tab.session === target.session &&
    tab.path === target.path &&
    (tab.root ?? '') === (target.root ?? '') &&
    tabKind(tab) === tabKind(target)
  );
}

/** Find the ordinary tab a following preview should reveal back into. */
export function sourceTabLocation(
  tree: LayoutNode,
  target: EditorTab,
  preferredLeafId?: string,
): SourceTabLocation | null {
  const candidates = allLeaves(tree).flatMap((leaf) =>
    leaf.tabs.flatMap((ref): SourceTabLocation[] => {
      if (
        ref.type !== 'editor' ||
        ref.tab.view === 'linked' ||
        ref.tab.view === 'locked' ||
        !sameFollowingTarget(ref.tab as EditorTab, target)
      ) {
        return [];
      }
      return [{ leafId: leaf.id, ref: ref as TabRef & { type: 'editor' } }];
    }),
  );
  return (
    candidates.find(({ leafId }) => leafId === preferredLeafId) ??
    candidates.find(({ ref }) => (ref.tab.view ?? 'source') === 'source') ??
    candidates[0] ??
    null
  );
}

/** Set the active tab of a leaf. */
export function focusTab(tree: LayoutNode, leafId: string, key: string): LayoutNode {
  return transformLeaf(tree, leafId, (leaf) =>
    leaf.tabs.some((t) => tabRefKey(t) === key) ? { ...leaf, activeKey: key } : leaf,
  ) as LayoutNode;
}

/** Persist a split's child sizes (from a Group's onLayoutChanged). */
export function resizeSplit(tree: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  function walk(node: LayoutNode): LayoutNode {
    if (node.kind === 'leaf') return node;
    if (node.id === splitId && sizes.length === node.children.length) {
      return { ...node, children: node.children.map(walk), sizes: [...sizes] };
    }
    return { ...node, children: node.children.map(walk) };
  }
  return walk(tree);
}

/**
 * The session a tab binds to, or null when it binds to none — the nil uuid,
 * which is what an untitled draft (10.3) and a directory-target tab (12.4)
 * carry. "No session" can never be dead, so liveness checks must not treat it
 * as a missing session and prune the tab away.
 */
export function tabSessionId(ref: TabRef): string | null {
  const sid = ref.type === 'terminal' ? ref.session : ref.tab.session;
  return sid === UNTITLED_SESSION ? null : sid;
}

/** Keep a tab whose session is still alive — and any tab that binds to none. */
export function boundToLiveSession(alive: ReadonlySet<string>): (ref: TabRef) => boolean {
  return (ref) => {
    const sid = tabSessionId(ref);
    return sid === null || alive.has(sid);
  };
}

/** Drop every tab for which `keep` is false (e.g. a dead session); collapses emptied leaves. */
export function pruneTabs(tree: LayoutNode, keep: (ref: TabRef) => boolean): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode =>
    node.kind === 'leaf'
      ? { ...node, tabs: node.tabs.filter(keep) }
      : { ...node, children: node.children.map(walk) };
  return normalise(walk(tree));
}

/**
 * Union several trees into one (the project-based → profile-based layout
 * transition, SPEC §11): each tree keeps its own structure and they sit
 * side-by-side in a row split, deduplicated left-to-right — a tab already
 * present in an earlier tree is pruned from the later one, and a tree that
 * empties (or was empty) contributes nothing. No trees → a single empty leaf.
 *
 * The slices being joined were sharded from ONE tree, so `dedupeIds` has the
 * last word: without it the union hands the renderer several panes under one
 * id (see "Node identity" above).
 */
export function joinTrees(trees: LayoutNode[]): LayoutNode {
  const seen = new Set<string>();
  const kept: LayoutNode[] = [];
  for (const tree of trees) {
    const pruned = normalise(pruneTabs(tree, (ref) => !seen.has(tabRefKey(ref))));
    const tabs = flattenTabs(pruned);
    if (tabs.length === 0) continue;
    for (const tab of tabs) seen.add(tabRefKey(tab));
    kept.push(pruned);
  }
  if (kept.length === 0) return makeLeaf([]);
  return dedupeIds(kept.length === 1 ? kept[0]! : normalise(makeSplit('row', kept)));
}

// ---- Migration from the legacy flat snapshot ------------------------------

/**
 * Build a tree equivalent to today's fixed layout from a legacy snapshot (when
 * `layout_tree` is null): the editor tabs above the terminal tabs in a column,
 * seeded from the flat `layout` sizes when present. Empty editor or terminal
 * sides collapse away, so a terminal-only workspace is a single leaf — matching
 * "no editor tab ⇒ terminals take the full height".
 */
export function buildInitialTree(snapshot: UiStateSnapshot): LayoutNode {
  const editorRefs: TabRef[] = snapshot.editor_tabs.map((tab) => ({ type: 'editor', tab }));
  const termRefs: TabRef[] = snapshot.session_tabs.map((session) => ({
    type: 'terminal',
    session,
  }));

  const activeEditorKey = snapshot.active_editor_tab
    ? tabRefKey({ type: 'editor', tab: snapshot.active_editor_tab })
    : null;
  const activeTermKey = snapshot.active_session ? `term:${snapshot.active_session}` : null;

  if (editorRefs.length === 0 && termRefs.length === 0) return makeLeaf([]);
  if (editorRefs.length === 0) return makeLeaf(termRefs, activeTermKey);
  if (termRefs.length === 0) return makeLeaf(editorRefs, activeEditorKey);

  const layout = snapshot.layout as Record<string, unknown>;
  const editorSize = typeof layout['editor'] === 'number' ? layout['editor'] : 40;
  const sessionSize = typeof layout['session'] === 'number' ? layout['session'] : 60;
  return normalise(
    makeSplit(
      'col',
      [makeLeaf(editorRefs, activeEditorKey), makeLeaf(termRefs, activeTermKey)],
      [editorSize, sessionSize],
    ),
  );
}
