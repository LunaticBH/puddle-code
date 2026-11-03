import { describe, expect, it } from 'vitest';
import {
  normaliseSourceAnchors,
  offsetAtSourceLine,
  sourceLineAtOffset,
} from '../../../src/features/editor/previews/source-anchor-map';

describe('semantic source anchor interpolation', () => {
  const anchors = normaliseSourceAnchors([
    { line: 1, offset: 0 },
    { line: 10, offset: 100 },
    // A tall image makes the next nine source lines occupy 500 rendered px.
    { line: 20, offset: 600 },
    { line: 40, offset: 800 },
  ]);

  it('maps source lines through real rendered geometry', () => {
    expect(offsetAtSourceLine(anchors, 5.5)).toBe(50);
    expect(offsetAtSourceLine(anchors, 15)).toBe(350);
    expect(offsetAtSourceLine(anchors, 30)).toBe(700);
  });

  it('inverts preview pixels to fractional source lines', () => {
    expect(sourceLineAtOffset(anchors, 50)).toBe(5.5);
    expect(sourceLineAtOffset(anchors, 350)).toBe(15);
    expect(sourceLineAtOffset(anchors, 700)).toBe(30);
  });

  it('drops nested duplicate and backwards anchors instead of producing jumps', () => {
    expect(
      normaliseSourceAnchors([
        { line: 1, offset: 0 },
        { line: 1, offset: 10 },
        { line: 8, offset: 100 },
        { line: 6, offset: 120 },
        { line: 12, offset: 180 },
      ]),
    ).toEqual([
      { line: 1, offset: 0 },
      { line: 8, offset: 100 },
      { line: 12, offset: 180 },
    ]);
  });
});
