import { describe, expect, it } from 'vitest';
import { initialCockpitBounds, restoredCockpitBounds } from '../src/window-bounds';

describe('desktop cockpit launch bounds', () => {
  it('bottom-aligns a preferred-size macOS window in a slightly taller work area', () => {
    expect(initialCockpitBounds('darwin', { x: 0, y: 29, width: 1440, height: 903 })).toEqual({
      x: 0,
      y: 32,
      width: 1440,
      height: 900,
    });
  });

  it('clamps to a smaller macOS work area and meets every edge', () => {
    expect(initialCockpitBounds('darwin', { x: 10, y: 24, width: 1280, height: 780 })).toEqual({
      x: 10,
      y: 24,
      width: 1280,
      height: 780,
    });
  });

  it('keeps Linux launch sizing independent of display geometry', () => {
    expect(initialCockpitBounds('linux')).toEqual({ width: 1440, height: 900 });
    expect(initialCockpitBounds('linux', { x: 0, y: 0, width: 1280, height: 680 })).toEqual({
      width: 1440,
      height: 900,
    });
  });

  it('clamps and centres a Windows window inside a scaled laptop work area', () => {
    expect(initialCockpitBounds('win32', { x: 0, y: 0, width: 1280, height: 680 })).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 680,
    });
    expect(initialCockpitBounds('win32', { x: -1920, y: 0, width: 1920, height: 1040 })).toEqual({
      x: -1680,
      y: 70,
      width: 1440,
      height: 900,
    });
    expect(initialCockpitBounds('win32')).toEqual({ width: 1440, height: 900 });
  });
});

describe('restored desktop cockpit bounds', () => {
  const displays = [
    { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } },
    { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } },
  ];

  it('returns a window to the same display and monitor-relative offset', () => {
    expect(
      restoredCockpitBounds('darwin', displays, {
        bounds: { x: -1800, y: 80, width: 1200, height: 800 },
        displayId: 2,
        // The display sat left of primary before it was rearranged to the right.
        displayWorkArea: { x: -1920, y: 0, width: 1920, height: 1080 },
      }),
    ).toEqual({ x: 1560, y: 80, width: 1200, height: 800 });
  });

  it('clamps oversized or offscreen bounds inside the restored display', () => {
    expect(
      restoredCockpitBounds('linux', displays, {
        bounds: { x: 3000, y: 900, width: 2400, height: 1400 },
        displayId: 2,
        displayWorkArea: { x: 1440, y: 0, width: 1920, height: 1080 },
      }),
    ).toEqual({ x: 1440, y: 0, width: 1920, height: 1080 });
  });

  it('falls back safely to primary when the saved display disappeared', () => {
    expect(
      restoredCockpitBounds('linux', displays, {
        bounds: { x: 1800, y: 200, width: 1000, height: 700 },
        displayId: 99,
        displayWorkArea: { x: 1440, y: 0, width: 1920, height: 1080 },
      }),
    ).toEqual({ x: 360, y: 200, width: 1000, height: 700 });
  });

  it('uses the display label when its numeric id changed across boots', () => {
    expect(
      restoredCockpitBounds('linux', [{ ...displays[1], id: 42, label: 'External Display' }], {
        bounds: { x: 1560, y: 80, width: 1200, height: 800 },
        displayId: 2,
        displayLabel: 'External Display',
        displayWorkArea: displays[1].workArea,
      }),
    ).toEqual({ x: 1560, y: 80, width: 1200, height: 800 });
  });
});
