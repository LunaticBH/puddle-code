import type { CompilationMode } from '@puddle/shared';

/**
 * Pure tab-order logic for the editor zone (SPEC §8). A tab is keyed by
 * `(kind, session, path, sha)`: a plain `file` editor, a worktree `diff`, or a
 * `commit` file diff. `file` and `diff` tabs share the same `(session, path)`
 * buffer the buffer store and drafts use; `commit` tabs are read-only sha→sha.
 * This module is deliberately monaco-free (no `buffer-store.ts` import) so it
 * is unit-testable under vitest and safe to reach from eager code: the
 * Workspace-level open handlers add/focus a tab here without pulling the lazy
 * editor chunk in.
 */

export type EditorTabKind = 'file' | 'diff' | 'commit' | 'external' | 'untitled';

/**
 * How a previewable (markdown/HTML) tab renders (SPEC §8): Monaco source,
 * a rendered preview of its own file, or one of two following previews whose
 * target is rewritten to the most recently active renderable tab: `linked`,
 * and `locked`, which also receives that tab's vertical scroll progress.
 */
export type EditorView = 'source' | 'preview' | 'linked' | 'locked';

export interface EditorTab {
  session: string;
  path: string;
  /** Absent means `file` — legacy snapshots stored files only (SPEC §8). */
  kind?: EditorTabKind;
  /** Set only for `commit` tabs: the commit whose file diff this shows. */
  sha?: string;
  /** HEAD→index or index→working-tree comparison for source-control diffs. */
  git_area?: import('@puddle/shared').GitArea;
  /**
   * Set only for `external` tabs: the absolute browse root the explorer's
   * parent navigation opened this file under — `path` is relative to it,
   * and the tab uses that root for reads and writes (SPEC §8).
   */
  root?: string;
  /**
   * How a `file` tab renders: Monaco source (absent/`source`), a rendered
   * `preview`, or a retargeting `linked`/`locked` preview (markdown/HTML —
   * SPEC §8).
   * `source`/`preview` are deliberately NOT part of `tabKey`/`sameTab`:
   * toggling the view rewrites the same tab, never opens a second. Each
   * following mode IS keyed as its own stable slot — see `tabKey`.
   */
  view?: EditorView;
  /** Provider-backed execution mode; absent is the on-demand default. */
  compile_mode?: CompilationMode;
  /** Provider that generated this otherwise ordinary file tab. */
  generated_by?: string;
}

/** The effective kind, treating an absent `kind` as `file`. */
export function tabKind(tab: EditorTab): EditorTabKind {
  return tab.kind ?? 'file';
}

/**
 * Stable React key / map key for a tab, unique across every kind.
 *
 * A following tab keys as the constant mode name, not by its target: it is a
 * stable SLOT whose identity fields are rewritten on every retarget (SPEC
 * §8), and a key carrying them would change under React, `activeKey`, and the
 * layout signature each time. Distinct constants let one leaf hold one linked
 * slot and one locked slot without either colliding with the ordinary file.
 */
export function tabKey(tab: EditorTab): string {
  if (tab.view === 'linked' || tab.view === 'locked') return tab.view;
  const base = `${tabKind(tab)}:${tab.session}:${tab.sha ?? ''}:${tab.root ?? ''}:${tab.path}`;
  // Preserve every pre-15.3 key byte-for-byte: activeKey/previewKey persist in
  // layout snapshots. Only the new source-control variants need a suffix to
  // distinguish HEAD→index from index→working tree.
  return tab.git_area === undefined ? base : `${base}:git-${tab.git_area}`;
}

export function sameTab(a: EditorTab, b: EditorTab): boolean {
  return tabKey(a) === tabKey(b);
}

export function hasTab(tabs: readonly EditorTab[], tab: EditorTab): boolean {
  return tabs.some((t) => sameTab(t, tab));
}

/** Appends `tab` if it is not already open; otherwise returns `tabs` unchanged (focus, don't duplicate). */
export function addOrFocusTab(tabs: readonly EditorTab[], tab: EditorTab): EditorTab[] {
  return hasTab(tabs, tab) ? [...tabs] : [...tabs, tab];
}

export function removeTab(tabs: readonly EditorTab[], tab: EditorTab): EditorTab[] {
  return tabs.filter((t) => !sameTab(t, tab));
}

/**
 * Which tab should be active once `closing` is removed, given the current
 * `active` tab. Closing an inactive tab keeps `active`; closing the active tab
 * lands on its right neighbour, else its left neighbour, else null (last tab).
 */
export function activeAfterClose(
  tabs: readonly EditorTab[],
  closing: EditorTab,
  active: EditorTab | null,
): EditorTab | null {
  if (!active || !sameTab(active, closing)) return active;
  const idx = tabs.findIndex((t) => sameTab(t, closing));
  if (idx === -1) return active;
  const remaining = removeTab(tabs, closing);
  if (remaining.length === 0) return null;
  return remaining[Math.min(idx, remaining.length - 1)] ?? null;
}

/** Moves `dragged` to sit immediately before `before` (HTML5 drag reorder). */
export function reorderTabs(
  tabs: readonly EditorTab[],
  dragged: EditorTab,
  before: EditorTab,
): EditorTab[] {
  if (sameTab(dragged, before)) return [...tabs];
  const next = removeTab(tabs, dragged);
  const at = next.findIndex((t) => sameTab(t, before));
  if (at === -1) return [...tabs];
  next.splice(at, 0, dragged);
  return next;
}
