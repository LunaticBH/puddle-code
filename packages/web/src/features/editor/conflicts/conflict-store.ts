/**
 * Saves the daemon REFUSED because the file moved on disk under the buffer
 * (409 `stale_file`, SPEC §8) — one per buffer, held until it is reconciled.
 *
 * A conflict starts `unresolved`: editing stays available and a dismissable
 * notification offers Compare. Choosing it advances synchronously to `loading`,
 * which removes every editable view of the shared model before the disk read
 * begins. Only `comparing` binds that model into an editable DiffEditor again.
 * A failed read stays locked and exposes Retry rather than silently dropping the
 * user back into an editor whose comparison never appeared.
 *
 * `revision` makes the asynchronous disk read race-safe. A second stale save can
 * replace a conflict while the first read is in flight; its older completion may
 * not install the wrong disk version over the newer question.
 *
 * Monaco-free (plain data + listeners), so transitions are independently
 * testable and every view of a shared buffer reads one source of truth.
 */
interface ConflictBase {
  revision: number;
}

export interface UnresolvedDiskConflict extends ConflictBase {
  phase: 'unresolved';
}

export interface LoadingDiskConflict extends ConflictBase {
  phase: 'loading';
}

export interface ComparedDiskConflict extends ConflictBase {
  /** `opening` keeps the model locked until Monaco has mounted both diff sides. */
  phase: 'opening' | 'comparing';
  /** The file's content as it is on disk now — the version shown on the left. */
  content: string;
  /** That content's mtime: what a reconciled save must expect. */
  mtimeMs: number;
}

export interface FailedDiskConflict extends ConflictBase {
  phase: 'load-error';
  message: string;
}

export type DiskConflict =
  UnresolvedDiskConflict | LoadingDiskConflict | ComparedDiskConflict | FailedDiskConflict;

const conflicts = new Map<string, DiskConflict>();
const listeners = new Map<string, Set<() => void>>();
let nextRevision = 1;

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

function setConflict(key: string, conflict: DiskConflict): void {
  conflicts.set(key, conflict);
  notify(key);
}

/** Record a newly refused save without taking the user out of their editor. */
export function registerConflict(key: string): DiskConflict {
  const conflict: UnresolvedDiskConflict = { phase: 'unresolved', revision: nextRevision++ };
  setConflict(key, conflict);
  return conflict;
}

/** Lock the buffer and begin loading the disk side. Returns its race token. */
export function beginComparison(key: string): number | null {
  const current = conflicts.get(key);
  if (!current || (current.phase !== 'unresolved' && current.phase !== 'load-error')) return null;
  setConflict(key, { phase: 'loading', revision: current.revision });
  return current.revision;
}

/** Install the disk side only if this is still the comparison that requested it. */
export function completeComparison(
  key: string,
  revision: number,
  content: string,
  mtimeMs: number,
): boolean {
  const current = conflicts.get(key);
  if (!current || current.phase !== 'loading' || current.revision !== revision) return false;
  setConflict(key, { phase: 'opening', revision, content, mtimeMs });
  return true;
}

/** Monaco has both models mounted; the modified side may become editable. */
export function finishOpeningComparison(key: string, revision: number): boolean {
  const current = conflicts.get(key);
  if (!current || current.phase !== 'opening' || current.revision !== revision) return false;
  setConflict(key, { ...current, phase: 'comparing' });
  return true;
}

/** Keep a failed comparison locked and make the failed read explicitly retryable. */
export function failComparison(key: string, revision: number, message: string): boolean {
  const current = conflicts.get(key);
  if (!current || current.phase !== 'loading' || current.revision !== revision) return false;
  setConflict(key, { phase: 'load-error', revision, message });
  return true;
}

/** Whether focusing this buffer should offer its dismissable Compare notification. */
export function shouldOfferComparison(conflict: DiskConflict | null, focused: boolean): boolean {
  return focused && conflict?.phase === 'unresolved';
}

/** Only a disk version the user has actually seen is a valid merged-save baseline. */
export function comparedMtime(conflict: DiskConflict | null): number | undefined {
  return conflict?.phase === 'comparing' ? conflict.mtimeMs : undefined;
}

/** Every phase before the mounted diff exposes no editable Monaco for this model. */
export function comparisonLocksBuffer(conflict: DiskConflict | null): boolean {
  return (
    conflict?.phase === 'loading' ||
    conflict?.phase === 'load-error' ||
    conflict?.phase === 'opening'
  );
}

export function hasComparisonContent(conflict: DiskConflict): conflict is ComparedDiskConflict {
  return conflict.phase === 'opening' || conflict.phase === 'comparing';
}

/** Clear process-global state between isolated store consumers (tests). */
export function clearAllConflicts(): void {
  conflicts.clear();
  listeners.clear();
  nextRevision = 1;
}

export function clearConflict(key: string): void {
  if (!conflicts.delete(key)) return;
  notify(key);
}

export function conflictFor(key: string): DiskConflict | null {
  return conflicts.get(key) ?? null;
}

/** Subscribe to one buffer's conflict state — shaped for `useSyncExternalStore`. */
export function subscribeConflict(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}
