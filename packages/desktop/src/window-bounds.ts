import type { WindowPlacement } from './reopen.js';

export interface DisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface DisplayGeometry {
  id: number;
  label?: string;
  workArea: DisplayWorkArea;
}

const PREFERRED = { width: 1440, height: 900 };

/**
 * Initial cockpit geometry; macOS always meets the work area's bottom edge.
 * Windows laptops at 125-150% scaling have work areas of roughly 1280x680 to
 * 1536x816 device-independent pixels, so the preferred size is clamped and
 * centred there too.
 */
export function initialCockpitBounds(
  platform: NodeJS.Platform,
  workArea?: DisplayWorkArea,
): WindowBounds {
  if (platform === 'win32' && workArea !== undefined) return centredBounds(workArea);
  if (platform !== 'darwin' || workArea === undefined) return PREFERRED;
  const width = Math.min(PREFERRED.width, workArea.width);
  const height = Math.min(PREFERRED.height, workArea.height);
  return {
    width,
    height,
    // Keep narrower windows horizontally centred, but bottom-align every
    // height. A 900px window on a 903px work area otherwise leaves a visible
    // two-pixel strip after integer centring (floor above, remainder below).
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + workArea.height - height,
  };
}

function centredBounds(workArea: DisplayWorkArea): WindowBounds {
  const width = Math.min(PREFERRED.width, workArea.width);
  const height = Math.min(PREFERRED.height, workArea.height);
  return {
    width,
    height,
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Restore monitor-relative normal bounds. `displays` is primary-first: when a
 * saved monitor disappeared, the primary is the predictable safe fallback.
 * Native Wayland may ignore x/y at the compositor boundary; returning honest
 * geometry here keeps the policy independent of that platform limitation.
 */
export function restoredCockpitBounds(
  platform: NodeJS.Platform,
  displays: DisplayGeometry[],
  placement?: WindowPlacement,
): WindowBounds {
  const primary = displays[0];
  const fallback = initialCockpitBounds(platform, primary?.workArea);
  if (!placement || !primary) return fallback;

  const display =
    displays.find((candidate) => candidate.id === placement.displayId) ??
    (placement.displayLabel
      ? displays.find((candidate) => candidate.label === placement.displayLabel)
      : undefined) ??
    primary;
  const area = display.workArea;
  const oldArea = placement.displayWorkArea ?? area;
  const width = Math.min(placement.bounds.width, area.width);
  const height = Math.min(placement.bounds.height, area.height);
  // Translate from the old monitor's coordinate space before clamping. This
  // preserves the offset when a display is rearranged between launches.
  const translatedX = area.x + (placement.bounds.x - oldArea.x);
  const translatedY = area.y + (placement.bounds.y - oldArea.y);
  return {
    x: clamp(translatedX, area.x, area.x + area.width - width),
    y: clamp(translatedY, area.y, area.y + area.height - height),
    width,
    height,
  };
}
