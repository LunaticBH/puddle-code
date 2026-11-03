import { describe, expect, it } from 'vitest';
import {
  findColourQueries,
  hexToXtermRgb,
  QUERY_CARRY,
  TerminalTheme,
} from '../../src/pty/terminal-theme.js';

describe('hexToXtermRgb', () => {
  it('doubles each channel into the 16-bit X11 form', () => {
    expect(hexToXtermRgb('#0a1b2c')).toBe('rgb:0a0a/1b1b/2c2c');
    expect(hexToXtermRgb('FFFFFF')).toBe('rgb:ffff/ffff/ffff');
    expect(hexToXtermRgb('#fff')).toBeNull(); // shorthand is the caller's problem
    expect(hexToXtermRgb('oklch(0.2 0 0)')).toBeNull();
  });
});

describe('findColourQueries', () => {
  const q = (code: number, st = '\x07') => `\x1b]${code};?${st}`;

  it('finds BEL- and ST-terminated queries, ignoring set requests', () => {
    expect(findColourQueries('', `${q(11)}hello${q(10, '\x1b\\')}`)).toEqual([11, 10]);
    // A SET request (a colour, not `?`) is not a query.
    expect(findColourQueries('', '\x1b]11;rgb:00/00/00\x07')).toEqual([]);
  });

  it('completes a query split across chunks via the carry, exactly once', () => {
    const query = q(11);
    const head = query.slice(0, 4);
    const rest = query.slice(4);
    expect(findColourQueries('', head)).toEqual([]);
    expect(findColourQueries(head.slice(-QUERY_CARRY), rest)).toEqual([11]);
  });

  it('never re-answers a query that ended inside the carry', () => {
    const chunk = `output${q(11)}`; // the query completes THIS chunk…
    expect(findColourQueries('', chunk)).toEqual([11]);
    // …so the next chunk, whose carry still holds it whole, must not repeat it.
    expect(findColourQueries(chunk.slice(-QUERY_CARRY), 'more output')).toEqual([]);
  });
});

describe('TerminalTheme', () => {
  it('answers nothing before a report, then the last-reported colours', () => {
    const theme = new TerminalTheme();
    expect(theme.report(11)).toBeNull();
    theme.set('#e8e4da', '#10192b');
    expect(theme.report(10)).toBe('\x1b]10;rgb:e8e8/e4e4/dada\x1b\\');
    expect(theme.report(11)).toBe('\x1b]11;rgb:1010/1919/2b2b\x1b\\');
    theme.set('#111111', '#fafafa'); // a light-theme report replaces the dark one
    expect(theme.report(11)).toBe('\x1b]11;rgb:fafa/fafa/fafa\x1b\\');
  });
});
