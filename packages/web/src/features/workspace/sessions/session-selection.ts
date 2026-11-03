import { z } from 'zod';

/** Companion payload for a native sidebar drag that carries several sessions. */
export const SESSION_DRAG_MIME = 'application/x-puddle-sessions';

const sessionDragSchema = z.array(z.string().uuid()).min(1);

export interface SessionSelectionState {
  selection: ReadonlySet<string>;
  anchor: string | null;
}

export interface SessionSelectionModifiers {
  shift: boolean;
  toggle: boolean;
}

/**
 * Select one sidebar session, toggle it, or replace the selection with the
 * inclusive range from the last non-range selection. `visibleIds` is already
 * flattened across project groups, so Shift works identically in both sidebar
 * presentations and may span a project heading.
 */
export function nextSessionSelection(
  visibleIds: readonly string[],
  current: ReadonlySet<string>,
  anchor: string | null,
  target: string,
  modifiers: SessionSelectionModifiers,
): SessionSelectionState {
  if (modifiers.toggle) {
    const next = new Set(current);
    if (next.has(target)) next.delete(target);
    else next.add(target);
    return { selection: next, anchor: target };
  }

  if (modifiers.shift && anchor !== null) {
    const from = visibleIds.indexOf(anchor);
    const to = visibleIds.indexOf(target);
    if (from !== -1 && to !== -1) {
      const start = Math.min(from, to);
      const end = Math.max(from, to);
      return { selection: new Set(visibleIds.slice(start, end + 1)), anchor };
    }
  }

  return { selection: new Set([target]), anchor: target };
}

/** Keep only rows that remain visible after an archive, scope change, or refresh. */
export function retainVisibleSessions(
  selection: ReadonlySet<string>,
  visibleIds: readonly string[],
): ReadonlySet<string> {
  const visible = new Set(visibleIds);
  const next = new Set([...selection].filter((id) => visible.has(id)));
  if (next.size === selection.size && [...next].every((id) => selection.has(id))) return selection;
  return next;
}

/**
 * Dragging a selected row carries the whole selection in visible order;
 * dragging outside it acts on that row alone.
 */
export function sessionsForDrag(
  visibleIds: readonly string[],
  selection: ReadonlySet<string>,
  target: string,
): string[] {
  if (!selection.has(target) || selection.size < 2) return [target];
  const selected = visibleIds.filter((id) => selection.has(id));
  return selected.length > 0 ? selected : [target];
}

export function encodeSessionDrag(ids: readonly string[]): string {
  return JSON.stringify(ids);
}

/** Parse and validate an internal multi-session drag, deduplicating stale input. */
export function decodeSessionDrag(raw: string): string[] {
  try {
    return [...new Set(sessionDragSchema.parse(JSON.parse(raw)))];
  } catch {
    return [];
  }
}

export function hasSessionDrag(types: readonly string[]): boolean {
  return types.includes(SESSION_DRAG_MIME);
}
