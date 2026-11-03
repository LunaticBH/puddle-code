/** A point measured in PDF big points (72 dpi) from the visible page's top-left. */
export interface PdfPagePoint {
  x: number;
  y: number;
}

export const PDF_ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
export const PDF_MIN_ZOOM = PDF_ZOOM_LEVELS[0];
export const PDF_MAX_ZOOM = PDF_ZOOM_LEVELS.at(-1)!;

/** Bound a continuous gesture scale to the same range as the explicit controls. */
export function clampPdfZoom(zoom: number): number {
  return clamp(zoom, PDF_MIN_ZOOM, PDF_MAX_ZOOM);
}

/**
 * Turn pixel-like wheel input from a trackpad pinch into a smooth multiplicative
 * scale. Multiplication keeps zoom speed perceptually even at every scale.
 */
export function pdfWheelZoom(current: number, deltaPixels: number): number {
  return clampPdfZoom(current * Math.exp(-deltaPixels * 0.01));
}

/** Scale a two-touch pinch from the distance recorded when the gesture began. */
export function pdfPinchZoom(
  initialZoom: number,
  initialDistance: number,
  currentDistance: number,
): number {
  if (initialDistance <= 0 || currentDistance <= 0) return clampPdfZoom(initialZoom);
  return clampPdfZoom(initialZoom * (currentDistance / initialDistance));
}

/** Retain one decimal place when a gesture lands between the button stops. */
export function formatPdfZoom(zoom: number): string {
  const percentage = Math.round(clampPdfZoom(zoom) * 1_000) / 10;
  return `${Number.isInteger(percentage) ? percentage.toFixed(0) : percentage.toFixed(1)}%`;
}

/** Move to the next explicit zoom stop; 100% means fit to the pane width. */
export function adjacentPdfZoom(current: number, direction: 'in' | 'out'): number {
  if (direction === 'in') {
    return (
      PDF_ZOOM_LEVELS.find((level) => level > current + Number.EPSILON) ?? PDF_ZOOM_LEVELS.at(-1)!
    );
  }
  return (
    [...PDF_ZOOM_LEVELS].reverse().find((level) => level < current - Number.EPSILON) ??
    PDF_ZOOM_LEVELS[0]
  );
}

/**
 * HiDPI output scale with a pixel budget. Zoom changes CSS size independently,
 * so a large page remains usable without allocating an unbounded canvas.
 */
export function pdfRenderOutputScale(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixels = 12_000_000,
): number {
  const preferred = Math.max(1, Math.min(devicePixelRatio || 1, 2.5));
  const cssPixels = cssWidth * cssHeight;
  if (cssPixels <= 0 || maxPixels <= 0) return 1;
  return Math.max(0.25, Math.min(preferred, Math.sqrt(maxPixels / cssPixels)));
}

/**
 * Converts a pointer position on a fitted PDF canvas to the coordinates
 * accepted by SyncTeX. `pageWidth` / `pageHeight` are the PDF.js viewport at
 * scale 1, whose units are big points. The ratio keeps the result correct when
 * CSS rounds a fitted canvas to a fractional pixel.
 */
export function pdfPagePoint(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  pageWidth: number,
  pageHeight: number,
): PdfPagePoint | null {
  if (bounds.width <= 0 || bounds.height <= 0 || pageWidth <= 0 || pageHeight <= 0) {
    return null;
  }

  const localX = clamp(clientX - bounds.left, 0, bounds.width);
  const localY = clamp(clientY - bounds.top, 0, bounds.height);
  return {
    x: (localX / bounds.width) * pageWidth,
    y: (localY / bounds.height) * pageHeight,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
