/**
 * Pure drop-zone geometry for the tiling layout's drag-and-drop (SPEC §8),
 * unit-tested without a DOM. Given a pane's size and the pointer position
 * within it, decide whether a drop lands in the centre (append to the leaf) or
 * on an edge (split that direction). The centre box is the inner `1 - 2*edge`
 * of each axis; outside it, the nearest edge wins (corners resolve to whichever
 * edge the pointer is closer to).
 */

import type { DropEdge } from './layout-tree';

export interface Size {
  width: number;
  height: number;
}

/** Pointer position RELATIVE to the pane's top-left (0..width, 0..height). */
export interface Point {
  x: number;
  y: number;
}

export function zoneForPointer(rect: Size, point: Point, edge = 0.25): DropEdge {
  if (rect.width <= 0 || rect.height <= 0) return 'center';
  const fx = clamp01(point.x / rect.width);
  const fy = clamp01(point.y / rect.height);

  if (fx > edge && fx < 1 - edge && fy > edge && fy < 1 - edge) return 'center';

  const toLeft = fx;
  const toRight = 1 - fx;
  const toTop = fy;
  const toBottom = 1 - fy;
  const nearest = Math.min(toLeft, toRight, toTop, toBottom);
  if (nearest === toTop) return 'top';
  if (nearest === toBottom) return 'bottom';
  if (nearest === toLeft) return 'left';
  return 'right';
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
