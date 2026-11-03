import { describe, expect, it } from 'vitest';
// @ts-expect-error plain-mjs module shared with scripts/check-tokens.mjs
import { contrastRatio, parseHex, relativeLuminance } from '../../../scripts/contrast.mjs';

describe('parseHex', () => {
  it('parses six-digit hex', () => {
    expect(parseHex('#7dadff')).toEqual([0x7d, 0xad, 0xff]);
  });
  it('expands three-digit hex', () => {
    expect(parseHex('#abc')).toEqual([0xaa, 0xbb, 0xcc]);
  });
  it('ignores an alpha channel', () => {
    expect(parseHex('#7dadff4d')).toEqual([0x7d, 0xad, 0xff]);
  });
  it('rejects non-hex input', () => {
    expect(() => parseHex('rgb(0,0,0)')).toThrow(/not a hex colour/);
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });
  it('is symmetric', () => {
    expect(contrastRatio('#7dadff', '#000a14')).toBeCloseTo(
      contrastRatio('#000a14', '#7dadff'),
      10,
    );
  });
  it('is 1:1 for identical colours', () => {
    expect(contrastRatio('#8be8b3', '#8be8b3')).toBe(1);
  });
  it('matches a known WCAG reference pair', () => {
    // #767676 on white is the canonical "just passes 4.5:1" grey.
    const ratio = contrastRatio('#767676', '#ffffff');
    expect(ratio).toBeGreaterThan(4.5);
    expect(ratio).toBeLessThan(4.6);
  });
});
