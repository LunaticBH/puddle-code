import type { TabRef } from '@puddle/shared';

/**
 * The recently-closed-tab stack behind the `tab.reopen` hotkey (SPEC §11).
 * Closing a tab remembers WHERE it was — the pane and its position in that
 * pane's strip — so a reopen puts it back rather than appending it somewhere
 * new.
 *
 * Entries are keyed by layout scope (`profile`, or `project:<id>` under
 * project-based layout) because the scope names the tree a reopen inserts into:
 * the profile-wide surface and each project's own layout keep separate stacks,
 * so a reopen can never resurrect a tab into a tree it was never part of.
 *
 * Deliberately in-memory and per window: this is an undo affordance for the
 * session at hand, not persisted state. A reload starts with a clean stack and
 * nothing about it belongs in the shared `ui_state` snapshot.
 */

export interface ClosedTab {
  /** The pane it was closed from — a reopen's preferred target. */
  leafId: string;
  /** Its index in that pane's strip, so it returns to the same position. */
  index: number;
  ref: TabRef;
}

/** How many closures a scope remembers — an undo depth, not a history. */
const DEPTH = 20;

const stacks = new Map<string, ClosedTab[]>();

export function rememberClosedTab(scope: string, entry: ClosedTab): void {
  const stack = stacks.get(scope) ?? [];
  stack.push(entry);
  if (stack.length > DEPTH) stack.shift();
  stacks.set(scope, stack);
}

/**
 * The most recent closure in `scope` that `usable` still accepts, dropping the
 * ones it rejects on the way — a tab whose session has since been archived or
 * deleted must not come back. Undefined when nothing is left to reopen.
 */
export function takeClosedTab(
  scope: string,
  usable: (ref: TabRef) => boolean,
): ClosedTab | undefined {
  const stack = stacks.get(scope);
  while (stack && stack.length > 0) {
    const entry = stack.pop()!;
    if (usable(entry.ref)) return entry;
  }
  return undefined;
}

/** Drop every remembered closure (tests; nothing in the app forgets a stack). */
export function forgetClosedTabs(): void {
  stacks.clear();
}
