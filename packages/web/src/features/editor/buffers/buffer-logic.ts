/**
 * Pure logic backing the shared buffer store (SPEC §8): saved-version
 * bookkeeping and the editor-tab label rule. Deliberately monaco-free so it
 * is unit-testable under vitest — `monaco-editor` cannot initialise outside
 * a browser (it reaches for `window` at import time), so anything that
 * touches a real `ITextModel` lives in `buffer-store.ts` instead, behind the
 * lazy editor boundary. This module has no such restriction and may be
 * imported eagerly if ever useful, though today only `buffer-store.ts` does.
 */

/** One open editor tab's path identity; external files additionally carry `root`. */
export interface OpenTab {
  session: string;
  path: string;
  /** Absolute identity root for an external file; absent for a worktree file. */
  root?: string;
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * Tab label for `path` open under `(session, root)`, given every other currently
 * open tab and a session → branch lookup (SPEC §8: `api.ts — alice/fix-auth`
 * when the same basename is open from more than one worktree).
 *
 * Two collision shapes, which COMPOSE (a basename can collide both ways at
 * once):
 *  - Cross-session: same basename open under a different session (almost
 *    always a different worktree/branch) → suffix with this tab's session
 *    branch, which disambiguates the sessions.
 *  - Same-session: two different paths under ONE session happen to share a
 *    basename (e.g. `src/api.ts` and `lib/api.ts` both open in one tab
 *    strip). Both tabs share the same branch, so a branch suffix alone
 *    cannot disambiguate — the label body becomes the full path instead,
 *    mirroring how editors show a parent directory when two same-named
 *    files are open side by side.
 * When both shapes apply (s1 has `src/api.ts` + `lib/api.ts` open while s2
 * has `other/api.ts`), the s1 tabs get path AND branch —
 * `src/api.ts — main` vs `lib/api.ts — main` — so every label stays unique.
 */
export function editorTabLabel(
  path: string,
  session: string,
  allTabs: readonly OpenTab[],
  sessionBranches: ReadonlyMap<string, string>,
  root?: string,
  sessionDirectories?: ReadonlyMap<string, string>,
): string {
  const base = basename(path);
  const collisions = allTabs.filter(
    (tab) =>
      !(tab.session === session && tab.path === path && tab.root === root) &&
      basename(tab.path) === base,
  );
  if (collisions.length === 0) return base;

  const sameSession = collisions.some((tab) => tab.session === session);
  const crossSession = collisions.some((tab) => tab.session !== session);

  // Two external files can have the same session AND the same root-relative
  // path while living under different browse roots. The old `(session,path)`
  // self-filter treated them as one tab, producing identical basename labels.
  // Include the absolute root only for that shape; ordinary same-basename
  // siblings retain the shorter `src/api.ts` / `lib/api.ts` treatment.
  const sameRelativePathUnderAnotherRoot = collisions.some(
    (tab) => tab.session === session && tab.path === path && tab.root !== root,
  );
  const branch = crossSession ? sessionBranches.get(session) : undefined;
  const sameBranchInAnotherSession = collisions.some(
    (tab) => tab.session !== session && sessionBranches.get(tab.session) === branch,
  );
  const directory = root ?? sessionDirectories?.get(session);
  const rootedPath = directory === undefined ? path : `${directory.replace(/\/+$/, '')}/${path}`;
  // A branch normally distinguishes cross-worktree collisions. It cannot when
  // two worktrees are on the same branch (or both branches are unknown), so the
  // effective absolute directory is the final, honest discriminator.
  const body =
    sameRelativePathUnderAnotherRoot || (sameBranchInAnotherSession && directory !== undefined)
      ? rootedPath
      : sameSession
        ? path
        : base;
  return branch ? `${body} — ${branch}` : body;
}

/**
 * The slice of a monaco `ITextModel` `applyDraft` needs — kept structural (and
 * generic over the model's range type `R`) so this stays monaco-free and
 * unit-testable: `buffer-store.ts` passes a real `ITextModel` (where `R` is
 * `monaco.Range`), tests pass a fake that records the edit.
 */
export interface DraftApplicableModel<R> {
  getValue(): string;
  getFullModelRange(): R;
  pushEditOperations(
    beforeCursorState: null,
    editOperations: { range: R; text: string }[],
    cursorStateComputer: () => null,
  ): unknown;
}

/**
 * Lays a restored draft on top of a model whose saved baseline is the disk
 * content (SPEC §11 reload semantics). The model must already hold the disk
 * content with `markSaved` recorded against it; a single full-range
 * `pushEditOperations` then swaps in the draft content so the edit lands on
 * the undo stack and the model reads as *dirty* relative to the saved
 * baseline (a plain `setValue` would reset the model and lose that dirty
 * signal). Returns whether an edit was pushed — a draft identical to disk is
 * a no-op and the buffer stays clean. `pushEditOperations` (not `setValue`)
 * for the same undo-history reason as `buffer-store.ts`'s `replaceContent`.
 */
export function applyDraft<R>(model: DraftApplicableModel<R>, draftContent: string): boolean {
  if (model.getValue() === draftContent) return false;
  model.pushEditOperations(
    null,
    [{ range: model.getFullModelRange(), text: draftContent }],
    () => null,
  );
  return true;
}

/**
 * Reference counting for shared models (SPEC §8). The editor tab and the diff
 * view's modified side bind the SAME `ITextModel`; either may open or close
 * first, so a model must only be disposed once its LAST holder lets go. Each
 * holder `retain`s the key on mount and `release`s on unmount; `release`
 * reports whether that was the final holder so the store can dispose then and
 * only then. Pure (no monaco), so the counting rule is unit-testable; the
 * actual `model.dispose()` lives in `buffer-store.ts`.
 */
export class RefCounter {
  private readonly counts = new Map<string, number>();

  retain(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /**
   * Drops one holder of `key`. Returns true exactly when the holder that just
   * left was the last one (count fell to zero) — the caller disposes then.
   * A release with no matching retain also returns true (dispose defensively)
   * without driving the count negative.
   */
  release(key: string): boolean {
    const n = this.counts.get(key);
    if (n === undefined || n <= 1) {
      this.counts.delete(key);
      return true;
    }
    this.counts.set(key, n - 1);
    return false;
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

interface SavedState {
  versionId: number;
  mtimeMs: number;
}

/**
 * Per-key saved-version/mtime bookkeeping, keyed by whatever string identity
 * the caller uses for (session, path) — `buffer-store.ts` composes this with
 * real monaco `ITextModel.getAlternativeVersionId()` values; tests pass
 * fabricated version numbers directly.
 */
export class SavedStateMap {
  private readonly saved = new Map<string, SavedState>();

  mark(key: string, versionId: number, mtimeMs: number): void {
    this.saved.set(key, { versionId, mtimeMs });
  }

  mtime(key: string): number | undefined {
    return this.saved.get(key)?.mtimeMs;
  }

  /** No baseline recorded yet ⇒ nothing to compare against ⇒ not dirty. */
  isDirty(key: string, currentVersionId: number): boolean {
    const state = this.saved.get(key);
    return state !== undefined && currentVersionId !== state.versionId;
  }

  delete(key: string): void {
    this.saved.delete(key);
  }

  /** Move a saved baseline with a buffer whose path-based identity changed. */
  rekey(from: string, to: string): void {
    if (from === to) return;
    const state = this.saved.get(from);
    this.saved.delete(from);
    if (state !== undefined) this.saved.set(to, state);
  }

  /** Keys whose current version (per the supplied map) diverges from saved. */
  dirtyKeys(currentVersionIds: ReadonlyMap<string, number>): string[] {
    return [...this.saved.keys()].filter((key) => {
      const current = currentVersionIds.get(key);
      return current !== undefined && this.isDirty(key, current);
    });
  }
}
