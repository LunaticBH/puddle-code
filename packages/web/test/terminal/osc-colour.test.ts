import { describe, expect, it } from 'vitest';
import { dynamicColourReport, hexToXtermRgb } from '../../src/features/terminal/osc-colour';

describe('hexToXtermRgb', () => {
  it('doubles each channel to the 16-bit XTerm form', () => {
    expect(hexToXtermRgb('#000a14')).toBe('rgb:0000/0a0a/1414');
    expect(hexToXtermRgb('#ffffff')).toBe('rgb:ffff/ffff/ffff');
  });
  it('accepts a colour without the leading hash', () => {
    expect(hexToXtermRgb('7dadff')).toBe('rgb:7d7d/adad/ffff');
  });
  it('ignores an alpha channel', () => {
    expect(hexToXtermRgb('#7dadff4d')).toBe('rgb:7d7d/adad/ffff');
  });
  it('lower-cases the output', () => {
    expect(hexToXtermRgb('#EAF1FB')).toBe('rgb:eaea/f1f1/fbfb');
  });
  it('rejects shorthand and non-hex input', () => {
    expect(hexToXtermRgb('#fff')).toBeNull();
    expect(hexToXtermRgb('rgb(0,0,0)')).toBeNull();
    expect(hexToXtermRgb('')).toBeNull();
  });
});

describe('dynamicColourReport', () => {
  it('wraps the background colour in an OSC 11 report with an ST terminator', () => {
    expect(dynamicColourReport(11, '#000a14')).toBe('\x1b]11;rgb:0000/0a0a/1414\x1b\\');
  });
  it('uses the query code for the foreground', () => {
    expect(dynamicColourReport(10, '#eaf1fb')).toBe('\x1b]10;rgb:eaea/f1f1/fbfb\x1b\\');
  });
  it('returns null when the colour cannot be parsed, so nothing is sent', () => {
    expect(dynamicColourReport(11, 'transparent')).toBeNull();
  });
});
