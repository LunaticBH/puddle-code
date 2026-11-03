import { describe, expect, it } from 'vitest';
import {
  adjacentPdfZoom,
  clampPdfZoom,
  formatPdfZoom,
  pdfPagePoint,
  pdfPinchZoom,
  pdfRenderOutputScale,
  pdfWheelZoom,
} from '../../../../src/features/editor/previews/pdf/pdf-coordinates';

describe('pdfPagePoint', () => {
  const bounds = { left: 100, top: 50, width: 400, height: 600 };

  it('maps fitted CSS coordinates to top-left PDF big points', () => {
    expect(pdfPagePoint(300, 350, bounds, 612, 792)).toEqual({ x: 306, y: 396 });
    expect(
      pdfPagePoint(500, 650, { left: 100, top: 50, width: 800, height: 1200 }, 612, 792),
    ).toEqual({ x: 306, y: 396 });
  });

  it('clamps pointer rounding at page edges', () => {
    expect(pdfPagePoint(99, 49, bounds, 612, 792)).toEqual({ x: 0, y: 0 });
    expect(pdfPagePoint(501, 651, bounds, 612, 792)).toEqual({ x: 612, y: 792 });
  });

  it('rejects unmeasurable pages', () => {
    expect(pdfPagePoint(100, 50, { ...bounds, width: 0 }, 612, 792)).toBeNull();
    expect(pdfPagePoint(100, 50, bounds, 0, 792)).toBeNull();
  });
});

describe('PDF zoom', () => {
  it('moves through bounded explicit zoom stops', () => {
    expect(adjacentPdfZoom(1, 'in')).toBe(1.25);
    expect(adjacentPdfZoom(1, 'out')).toBe(0.75);
    expect(adjacentPdfZoom(3, 'in')).toBe(3);
    expect(adjacentPdfZoom(0.5, 'out')).toBe(0.5);
  });

  it('scales fractionally for wheel and two-touch pinch gestures', () => {
    expect(pdfWheelZoom(1, -10)).toBeCloseTo(Math.exp(0.1));
    expect(pdfPinchZoom(1.25, 200, 220)).toBeCloseTo(1.375);
    expect(formatPdfZoom(1.375)).toBe('137.5%');
  });

  it('bounds continuous gestures to the explicit zoom range', () => {
    expect(clampPdfZoom(0.1)).toBe(0.5);
    expect(pdfWheelZoom(2.9, -100)).toBe(3);
    expect(pdfPinchZoom(0.75, 100, 10)).toBe(0.5);
  });

  it('keeps normal pages crisp and caps oversized canvas allocation', () => {
    expect(pdfRenderOutputScale(800, 1000, 2)).toBe(2);
    expect(pdfRenderOutputScale(4000, 5000, 2)).toBeCloseTo(Math.sqrt(12_000_000 / 20_000_000));
  });
});
