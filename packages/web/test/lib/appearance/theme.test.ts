import { describe, expect, it } from 'vitest';
import {
  expandShortHex,
  monacoThemeFrom,
  xtermThemeFrom,
  xtermVisualOptionsFrom,
  type TokenReader,
} from '../../../src/lib/appearance/theme';

describe('expandShortHex', () => {
  it('expands minifier-shortened 3- and 4-digit hex to canonical form', () => {
    // The production CSS minifier rewrites #ffffff → #fff; monaco's token
    // parser rejects the short form ("Illegal value for token color: #fff").
    expect(expandShortHex('#fff')).toBe('#ffffff');
    expect(expandShortHex('#7af')).toBe('#77aaff');
    expect(expandShortHex('#fff8')).toBe('#ffffff88');
  });

  it('passes canonical and non-hex values through untouched', () => {
    expect(expandShortHex('#7dadff')).toBe('#7dadff');
    expect(expandShortHex('#8be8b32e')).toBe('#8be8b32e');
    expect(expandShortHex('rgb(255, 255, 255)')).toBe('rgb(255, 255, 255)');
    expect(expandShortHex('')).toBe('');
  });
});

/** Reader that echoes the token name so mappings are directly assertable. */
const echo: TokenReader = (token) => `<${token}>`;

describe('xtermThemeFrom', () => {
  const theme = xtermThemeFrom(echo);

  it('maps chrome tokens onto the terminal', () => {
    expect(theme.background).toBe('<--bg-base>');
    expect(theme.foreground).toBe('<--text-primary>');
    expect(theme.cursor).toBe('<--accent>');
    expect(theme.selectionBackground).toBe('<--selection>');
  });

  it('maps all sixteen ANSI slots', () => {
    expect(theme.red).toBe('<--ansi-red>');
    expect(theme.brightMagenta).toBe('<--ansi-bright-magenta>');
    const slots = Object.values(theme);
    expect(slots).toHaveLength(21); // 16 ANSI + bg/fg/cursor/cursorAccent/selection
    expect(new Set(slots).size).toBe(20); // cursorAccent deliberately reuses --bg-base
  });

  it('enforces readable text when a TUI caches the opposite background luminance', () => {
    const options = xtermVisualOptionsFrom(echo);
    expect(options.theme).toEqual(theme);
    expect(options.minimumContrastRatio).toBe(4.5); // xterm's documented WCAG AA floor
  });
});

describe('monacoThemeFrom', () => {
  const hex: TokenReader = () => '#7dadff';

  it('picks the matching monaco base theme', () => {
    expect(monacoThemeFrom(hex, 'dark').base).toBe('vs-dark');
    expect(monacoThemeFrom(hex, 'light').base).toBe('vs');
  });

  it('emits bare RRGGBB for token rules and #-prefixed colours for the chrome', () => {
    const theme = monacoThemeFrom(hex, 'dark');
    for (const rule of theme.rules) {
      expect(rule.foreground).toBe('7dadff');
    }
    expect(theme.colors['editor.background']).toBe('#7dadff');
    expect(theme.colors['focusBorder']).toBe('#7dadff');
  });

  it('maps the diff tokens onto the diff editor insert/remove backgrounds', () => {
    const theme = monacoThemeFrom(echo, 'dark');
    expect(theme.colors['diffEditor.insertedTextBackground']).toBe('<--diff-added>');
    expect(theme.colors['diffEditor.removedTextBackground']).toBe('<--diff-removed>');
  });
});
