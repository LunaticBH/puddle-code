/**
 * Theme registry and runtime theme generation (SPEC §12).
 *
 * Adding a theme = one `[data-theme='<name>']` block in styles/tokens.css plus
 * one entry in THEMES here — zero component changes. The xterm and Monaco
 * themes are generated from the computed CSS variables so terminal, editor,
 * and chrome always share one palette.
 */

export const THEMES = ['dark', 'light'] as const;
export type ThemeName = (typeof THEMES)[number];
export type ThemePreference = ThemeName | 'system';

const STORAGE_KEY = 'puddle.theme';
/** No stored choice → follow the OS (the dark block remains the design default). */
const DEFAULT_PREFERENCE: ThemePreference = 'system';
const FALLBACK_THEME: ThemeName = 'dark';

type ThemeListener = (theme: ThemeName) => void;
const listeners = new Set<ThemeListener>();

function systemTheme(): ThemeName {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function resolveTheme(pref: ThemePreference): ThemeName {
  return pref === 'system' ? systemTheme() : pref;
}

export function storedPreference(): ThemePreference {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === 'system' || (THEMES as readonly string[]).includes(raw ?? '')
    ? (raw as ThemePreference)
    : DEFAULT_PREFERENCE;
}

export function currentTheme(): ThemeName {
  const applied = document.documentElement.dataset['theme'];
  return (THEMES as readonly string[]).includes(applied ?? '')
    ? (applied as ThemeName)
    : FALLBACK_THEME;
}

/** Sets data-theme, persists the preference, and notifies subscribers. */
export function applyTheme(pref: ThemePreference): ThemeName {
  localStorage.setItem(STORAGE_KEY, pref);
  const resolved = resolveTheme(pref);
  document.documentElement.dataset['theme'] = resolved;
  for (const listener of listeners) listener(resolved);
  return resolved;
}

/** Restores the stored preference at boot and follows OS changes on 'system'. */
export function initTheme(): void {
  applyTheme(storedPreference());
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (storedPreference() === 'system') applyTheme('system');
  });
}

/** Re-runs on every theme change; returns an unsubscribe. */
export function onThemeChange(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* -- Runtime theme generation ------------------------------------------ */

/** Resolved token lookup, e.g. read('--bg-base') → '#000a14'. */
export type TokenReader = (token: string) => string;

/**
 * Expands 3/4-digit hex shorthand to the canonical 6/8-digit form. The
 * production CSS minifier rewrites `#ffffff` → `#fff` inside the bundled
 * tokens, and monaco's token-theme parser accepts only the long forms
 * ("Illegal value for token color: #fff" — a blank screen in the built app,
 * invisible in dev where CSS ships unminified). Anything that isn't short
 * hex passes through untouched.
 */
export function expandShortHex(value: string): string {
  const short = /^#([0-9a-fA-F]{3,4})$/.exec(value);
  if (!short?.[1]) return value;
  return `#${[...short[1]].map((digit) => digit + digit).join('')}`;
}

export function cssTokenReader(): TokenReader {
  const style = getComputedStyle(document.documentElement);
  return (token) => expandShortHex(style.getPropertyValue(token).trim());
}

/** Matches @xterm/xterm's ITheme (structurally — no import needed here). */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * xterm's foreground correction floor. Agent TUIs may cache the OSC 10/11
 * colours they sampled at startup, then keep emitting a dark-theme background
 * after Puddle has switched to light (or vice versa). Their bytes must remain
 * untouched, but text over that stale background still has to be readable.
 */
export const TERMINAL_MINIMUM_CONTRAST_RATIO = 4.5;

/** The colour-bearing xterm options kept together as one visual contract. */
export interface TerminalVisualOptions {
  theme: TerminalTheme;
  minimumContrastRatio: number;
}

export function xtermThemeFrom(read: TokenReader): TerminalTheme {
  return {
    background: read('--bg-base'),
    foreground: read('--text-primary'),
    cursor: read('--accent'),
    cursorAccent: read('--bg-base'),
    selectionBackground: read('--selection'),
    black: read('--ansi-black'),
    red: read('--ansi-red'),
    green: read('--ansi-green'),
    yellow: read('--ansi-yellow'),
    blue: read('--ansi-blue'),
    magenta: read('--ansi-magenta'),
    cyan: read('--ansi-cyan'),
    white: read('--ansi-white'),
    brightBlack: read('--ansi-bright-black'),
    brightRed: read('--ansi-bright-red'),
    brightGreen: read('--ansi-bright-green'),
    brightYellow: read('--ansi-bright-yellow'),
    brightBlue: read('--ansi-bright-blue'),
    brightMagenta: read('--ansi-bright-magenta'),
    brightCyan: read('--ansi-bright-cyan'),
    brightWhite: read('--ansi-bright-white'),
  };
}

export function xtermThemeFromCss(): TerminalTheme {
  return xtermThemeFrom(cssTokenReader());
}

export function xtermVisualOptionsFrom(read: TokenReader): TerminalVisualOptions {
  return {
    theme: xtermThemeFrom(read),
    minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST_RATIO,
  };
}

export function xtermVisualOptionsFromCss(): TerminalVisualOptions {
  return xtermVisualOptionsFrom(cssTokenReader());
}

/**
 * Matches monaco.editor.IStandaloneThemeData structurally. Monaco itself
 * arrives in Phase 3; the generator ships (and is tested) now so themes stay
 * complete by construction.
 */
export interface EditorTheme {
  base: 'vs' | 'vs-dark';
  inherit: boolean;
  rules: Array<{ token: string; foreground?: string; fontStyle?: string }>;
  colors: Record<string, string>;
}

/** Monaco wants bare RRGGBB in rules and #RRGGBB(AA) in colors. */
function bare(colour: string): string {
  return colour.replace('#', '');
}

export function monacoThemeFrom(read: TokenReader, theme: ThemeName): EditorTheme {
  return {
    base: theme === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: bare(read('--text-muted')), fontStyle: 'italic' },
      { token: 'string', foreground: bare(read('--ansi-green')) },
      { token: 'number', foreground: bare(read('--ansi-yellow')) },
      { token: 'keyword', foreground: bare(read('--ansi-blue')) },
      { token: 'type', foreground: bare(read('--ansi-cyan')) },
      { token: 'function', foreground: bare(read('--ansi-magenta')) },
    ],
    colors: {
      'editor.background': read('--bg-base'),
      'editor.foreground': read('--text-primary'),
      'editor.selectionBackground': read('--selection'),
      'editor.lineHighlightBackground': read('--bg-surface'),
      'editorCursor.foreground': read('--accent'),
      'editorLineNumber.foreground': read('--text-muted'),
      'editorLineNumber.activeForeground': read('--text-secondary'),
      'editorWidget.background': read('--bg-elevated'),
      'editorWidget.border': read('--border'),
      focusBorder: read('--focus-ring'),
      'diffEditor.insertedTextBackground': read('--diff-added'),
      'diffEditor.removedTextBackground': read('--diff-removed'),
    },
  };
}

export function monacoThemeFromCss(): EditorTheme {
  return monacoThemeFrom(cssTokenReader(), currentTheme());
}
