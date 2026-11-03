import type { LayoutNode } from '@puddle/shared';
import { tabRefKey } from './layout-tree';

/**
 * Canonical signature of a tiling tree for saved-layout dirty detection
 * (SPEC §11): two trees compare equal iff they are the same layout as a user
 * would describe it — structure, tab identity, and split proportions.
 * Deliberately ignored: node ids (fresh per construction, never meaningful),
 * `activeKey`/`previewKey` (switching or previewing a tab is not a layout
 * change), and sub-0.1 size noise from resize drags. An empty leaf signs the
 * same as a null tree — restoring an empty saved layout leaves a workspace the
 * controller re-seeds with an empty leaf, and that must not read as drift.
 */
export function layoutSignature(tree: LayoutNode | null): string {
  return JSON.stringify(canonical(tree));
}

type Canonical = null | { t: string[] } | { d: string; s: number[]; c: Canonical[] };

function canonical(node: LayoutNode | null): Canonical {
  if (node === null) return null;
  if (node.kind === 'leaf') {
    if (node.tabs.length === 0) return null;
    return { t: node.tabs.map(tabRefKey) };
  }
  return {
    d: node.direction,
    s: node.sizes.map((size) => Math.round(size * 10) / 10),
    c: node.children.map(canonical),
  };
}
