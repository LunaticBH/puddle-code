import { describe, expect, it } from 'vitest';
import { zoneForPointer } from '../../../src/features/workspace/layout/layout-dnd';

const rect = { width: 100, height: 100 };

describe('zoneForPointer', () => {
  it('returns center for the inner box', () => {
    expect(zoneForPointer(rect, { x: 50, y: 50 })).toBe('center');
    expect(zoneForPointer(rect, { x: 30, y: 70 })).toBe('center'); // just inside the 25% band
  });

  it('picks the nearest edge outside the center box', () => {
    expect(zoneForPointer(rect, { x: 5, y: 50 })).toBe('left');
    expect(zoneForPointer(rect, { x: 95, y: 50 })).toBe('right');
    expect(zoneForPointer(rect, { x: 50, y: 5 })).toBe('top');
    expect(zoneForPointer(rect, { x: 50, y: 95 })).toBe('bottom');
  });

  it('resolves corners to the closer edge', () => {
    expect(zoneForPointer(rect, { x: 2, y: 10 })).toBe('left'); // closer to left than top
    expect(zoneForPointer(rect, { x: 10, y: 2 })).toBe('top'); // closer to top than left
  });

  it('clamps out-of-bounds points and guards a zero-size pane', () => {
    expect(zoneForPointer(rect, { x: -20, y: 50 })).toBe('left');
    expect(zoneForPointer({ width: 0, height: 0 }, { x: 0, y: 0 })).toBe('center');
  });

  it('respects a custom edge threshold', () => {
    // With a 10% edge, (15,50) is inside the center; with the default 25% it is left.
    expect(zoneForPointer(rect, { x: 15, y: 50 }, 0.1)).toBe('center');
    expect(zoneForPointer(rect, { x: 15, y: 50 })).toBe('left');
  });
});
