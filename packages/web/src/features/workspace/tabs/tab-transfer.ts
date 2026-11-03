import { tabRefSchema, type TabRef } from '@puddle/shared';

/**
 * The native-DnD payload for "something openable as a tab": file rows in the
 * explorer and session rows/dots in the right sidebar set it on drag start, and
 * the tiling panes accept it — so a drag out of a sidebar opens AND positions a
 * permanent tab through the same `dropTab` path strip drags use. Native HTML5
 * DnD (not dnd-kit) on purpose: both sources already are native draggables (the
 * tree for internal moves, the sidebar for reordering), and the two drag
 * systems cannot share one gesture.
 */
export const TAB_MIME = 'application/x-puddle-tab';

export function encodeTabTransfer(ref: TabRef): string {
  return JSON.stringify(ref);
}

/** Parse + validate a dropped payload; null for foreign or corrupt data. */
export function decodeTabTransfer(raw: string): TabRef | null {
  try {
    return tabRefSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Whether an in-flight drag carries a tab (readable during dragover, when the data itself is not). */
export function hasTabTransfer(types: readonly string[]): boolean {
  return types.includes(TAB_MIME);
}
