import { useSyncExternalStore } from 'react';
import { CLIENT_PLATFORM, type ClientPlatform } from '../client-platform';
import { desktopBridge } from '../desktop';

/**
 * The app's customisable keyboard shortcuts (SPEC §11). One registry of actions,
 * each with a default binding and a runtime handler a component registers on
 * mount; a single global dispatcher (installed by `HotkeysHost`) turns a keydown
 * into the matching action. Filetree navigation and terminal line-edits stay
 * fixed and are deliberately NOT here (SPEC §11 "global actions only").
 *
 * A binding is a canonical string: the modifiers `ctrl`/`alt`/`shift`/`meta` in
 * that fixed order, then a `KeyboardEvent.code` (e.g. `shift+meta+KeyE`,
 * `ctrl+Backquote`), so it is keyboard-layout-independent. The order is NOT
 * cosmetic and nothing validates it: the dispatcher compares `eventBinding`'s
 * output for equality, so a default written `meta+shift+…` is simply a shortcut
 * that never fires (`hotkeys.test.ts` guards the whole table).
 *
 * Two default sets (SPEC §11): the web defaults avoid combos browser chrome
 * would swallow; the DESKTOP shell — no chrome competing for keys — forks the
 * few where a native gesture is more intuitive (`desktopBinding`). Only the
 * defaults fork: a per-profile override applies in both shells. A Windows
 * client reads either set with Ctrl for ⌘ (`shellDefaultBinding`), and there a
 * focused terminal keeps plain Ctrl+letter chords (`terminalKeepsChord`).
 */
export interface HotkeyAction {
  id: string;
  label: string;
  group: string;
  defaultBinding: string;
  /** Desktop-shell default, where it differs from the web-safe one. */
  desktopBinding?: string;
  /** Bound inside Monaco (not the DOM dispatcher) — the editor owns the keys. */
  editor?: boolean;
  /** Yield to a focused terminal, which uses this key itself (e.g. ⌃A, ⌃`). */
  deferInTerminal?: boolean;
}

export const HOTKEY_GROUPS = ['Layout & tabs', 'Editor', 'Left sidebar', 'Right sidebar'] as const;

export const HOTKEY_ACTIONS: HotkeyAction[] = [
  {
    id: 'palette.toggle',
    label: 'Command palette',
    group: 'Layout & tabs',
    defaultBinding: 'meta+KeyK',
  },
  {
    id: 'tab.close',
    label: 'Close current tab',
    group: 'Layout & tabs',
    defaultBinding: 'ctrl+alt+KeyW',
    // The native close gesture; the shell's Close Window yields it (⌘⇧W).
    desktopBinding: 'meta+KeyW',
  },
  {
    id: 'tab.reopen',
    label: 'Reopen last closed tab',
    group: 'Layout & tabs',
    // ⌘⇧T is the browser's own reopen-closed-tab and never reaches the page,
    // so the web default follows `tab.close`'s ⌃⌥ pattern instead.
    defaultBinding: 'ctrl+alt+KeyT',
    desktopBinding: 'shift+meta+KeyT',
  },
  {
    id: 'tab.newUntitled',
    label: 'New untitled file',
    group: 'Layout & tabs',
    // ⌘N never reaches a browser tab (the chrome opens its own window), so the
    // web default joins the ⌃⌥ tab family; the desktop shell yields the native
    // key to the renderer (its New Window menu item moved to ⇧⌘N for it).
    defaultBinding: 'ctrl+alt+KeyN',
    desktopBinding: 'meta+KeyN',
  },
  // Cycling the focused pane's strip, in strip order, wrapping at both ends.
  // ⌃⇥ / ⌃⇧⇥ is the desktop default because that gesture means exactly this in
  // every tabbed app; a browser tab can never see it (the chrome switches its
  // OWN tabs), so the web default falls back to the ⌃⌥ family the other
  // tab actions already use — ⌃⌥] / ⌃⌥[ read as forwards/backwards and are
  // untaken by browser chrome (⌘⇧[ / ⌘⌥→ are not: both switch browser tabs).
  // Deliberately NOT `deferInTerminal`: switching away from a terminal you are
  // typing in is the main reason to reach for this.
  {
    id: 'tab.next',
    label: 'Next tab in pane',
    group: 'Layout & tabs',
    defaultBinding: 'ctrl+alt+BracketRight',
    desktopBinding: 'ctrl+Tab',
  },
  {
    id: 'tab.prev',
    label: 'Previous tab in pane',
    group: 'Layout & tabs',
    defaultBinding: 'ctrl+alt+BracketLeft',
    desktopBinding: 'ctrl+shift+Tab',
  },
  {
    id: 'window.close',
    label: 'Close window',
    group: 'Layout & tabs',
    // Naming the browser's own ⌘W is honest rather than useful: a tab cannot
    // intercept it (SPEC §11), and the chrome closes the window either way.
    defaultBinding: 'meta+KeyW',
    // The desktop shell's File → Close, which yields plain ⌘W to `tab.close`.
    desktopBinding: 'shift+meta+KeyW',
  },
  {
    id: 'sidebar.left',
    label: 'Toggle left sidebar',
    group: 'Layout & tabs',
    defaultBinding: 'alt+meta+Comma',
    // VSCode's primary-sidebar toggle.
    desktopBinding: 'meta+KeyB',
  },
  {
    id: 'sidebar.right',
    label: 'Toggle right sidebar',
    group: 'Layout & tabs',
    defaultBinding: 'alt+meta+Period',
    // ⇧⌘B, the pair to the left sidebar's ⌘B (decision 2026-08-03). NOT VSCode's
    // own secondary-sidebar ⌥⌘B: that is Open Worktrees here, and a pair the eye
    // reads as one gesture beats matching a foreign app key-for-key. A browser
    // keeps ⇧⌘B for its bookmarks bar, so only the desktop default forks.
    desktopBinding: 'shift+meta+KeyB',
  },
  { id: 'editor.save', label: 'Save', group: 'Editor', defaultBinding: 'meta+KeyS', editor: true },
  {
    id: 'editor.wordWrap',
    label: 'Toggle word wrap',
    group: 'Editor',
    defaultBinding: 'alt+KeyZ',
    editor: true,
  },
  {
    id: 'nav.files',
    label: 'Open Files',
    group: 'Left sidebar',
    defaultBinding: 'alt+meta+KeyE',
  },
  {
    id: 'nav.search',
    label: 'Open Search',
    group: 'Left sidebar',
    defaultBinding: 'alt+meta+KeyF',
  },
  {
    id: 'nav.changes',
    label: 'Open Changes',
    group: 'Left sidebar',
    defaultBinding: 'alt+meta+KeyV',
  },
  {
    id: 'nav.worktrees',
    label: 'Open Worktrees',
    group: 'Left sidebar',
    defaultBinding: 'alt+meta+KeyB',
  },
  {
    id: 'session.newAgent',
    label: 'New agent',
    group: 'Right sidebar',
    defaultBinding: 'ctrl+alt+Backquote',
    // "New tab" muscle memory — the primary new-thing here is an agent.
    desktopBinding: 'meta+KeyT',
  },
  {
    id: 'session.newTerminal',
    label: 'New terminal',
    group: 'Right sidebar',
    // ⌃`, not ⌘`: macOS owns ⌘` for "move focus to the next window"
    // (considered and rejected 2026-08-03).
    defaultBinding: 'ctrl+Backquote',
  },
  {
    id: 'scratchpad.toggle',
    label: 'Toggle Scratchpad',
    group: 'Right sidebar',
    defaultBinding: 'alt+meta+KeyS',
  },
  {
    id: 'layouts.toggle',
    label: 'Toggle Layouts',
    group: 'Right sidebar',
    defaultBinding: 'alt+meta+KeyL',
  },
];

const ACTION_BY_ID = new Map(HOTKEY_ACTIONS.map((a) => [a.id, a]));

/**
 * Which default set this window uses — evaluated once at import (the preload
 * bridge exists before any script runs). The `typeof window` guard keeps the
 * module importable under plain-Node vitest.
 */
const IS_DESKTOP = typeof window !== 'undefined' && desktopBridge() !== undefined;

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'];

/** A binding written for ⌘ moved onto Ctrl, keeping the canonical modifier order. */
function metaAsCtrl(binding: string): string {
  const parts = binding.split('+');
  const code = parts.pop() ?? '';
  const mods = new Set(parts.map((m) => (m === 'meta' ? 'ctrl' : m)));
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), code].join('+');
}

/**
 * The shell's default binding for an action: the desktop fork when in the
 * shell, else the web-safe one. On a Windows client every `meta` becomes
 * `ctrl`: Windows reserves the Windows key's combinations (Win+K, Win+S,
 * Win+Alt+…) for itself, so a default written for ⌘ would never reach the
 * page. Mac and Linux clients keep the defaults exactly as written, and a
 * profile override is always taken literally.
 */
export function shellDefaultBinding(
  action: HotkeyAction,
  desktop: boolean = IS_DESKTOP,
  client: ClientPlatform = CLIENT_PLATFORM,
): string {
  const binding = desktop && action.desktopBinding ? action.desktopBinding : action.defaultBinding;
  return client === 'windows' ? metaAsCtrl(binding) : binding;
}

/**
 * The canonical binding a keydown maps to, or null for a bare modifier press.
 * On a Windows client AltGr is a character key, not a modifier: Windows
 * reports it as Ctrl+Alt, so AltGr+E typing `€` on a German layout must not
 * fire a Ctrl+Alt+E shortcut. Mac and Linux clients read every keydown as
 * before.
 */
export function eventBinding(
  e: KeyboardEvent,
  client: ClientPlatform = CLIENT_PLATFORM,
): string | null {
  const code = e.code;
  if (!code || /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code)) return null;
  if (client === 'windows' && e.getModifierState?.('AltGraph')) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('meta');
  if (parts.length === 0) return null; // plain keys are never app hotkeys
  parts.push(code);
  return parts.join('+');
}

const SYMBOL: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' };
const CODE_LABEL: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Backquote: '`',
  Slash: '/',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Space: '␣',
  Enter: '↵',
  Escape: 'Esc',
  Tab: '⇥',
  BracketLeft: '[',
  BracketRight: ']',
};
function codeLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return CODE_LABEL[code] ?? code;
}

/** Windows names for the modifiers, and for keys whose Mac glyph means nothing there. */
const WINDOWS_MODIFIER_LABEL: Record<string, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Win',
};
const WINDOWS_CODE_LABEL: Record<string, string> = { Space: 'Space', Enter: 'Enter', Tab: 'Tab' };

/**
 * A binding string as the client spells shortcuts: spelled-out keys on a
 * Windows client (`ctrl+alt+KeyW` → `Ctrl+Alt+W`, `meta` named `Win`), and
 * Mac glyphs everywhere else (`shift+meta+KeyE` → `⇧⌘E`), as before.
 */
export function formatBinding(binding: string, client: ClientPlatform = CLIENT_PLATFORM): string {
  if (!binding) return '—';
  const parts = binding.split('+');
  const code = parts.pop() ?? '';
  if (client !== 'windows') return parts.map((m) => SYMBOL[m] ?? m).join('') + codeLabel(code);
  return [
    ...parts.map((m) => WINDOWS_MODIFIER_LABEL[m] ?? m),
    WINDOWS_CODE_LABEL[code] ?? codeLabel(code),
  ].join('+');
}

/**
 * The label of a FIXED shortcut written for ⌘ (the explorer's ⌘C, ⌥⌘C, …),
 * whose handlers accept Ctrl as well: Ctrl on a Windows client, the ⌘ glyphs
 * everywhere else.
 */
export function formatPrimaryShortcut(
  binding: string,
  client: ClientPlatform = CLIENT_PLATFORM,
): string {
  return formatBinding(client === 'windows' ? metaAsCtrl(binding) : binding, client);
}

// --- runtime handler registry (components register on mount) ---
const handlers = new Map<string, () => void>();
export function registerHotkey(id: string, handler: () => void): () => void {
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id);
  };
}
export const getHotkeyHandler = (id: string): (() => void) | undefined => handlers.get(id);
export const getHotkeyAction = (id: string): HotkeyAction | undefined => ACTION_BY_ID.get(id);

/**
 * Whether the shell must intercept an action in the capture phase, before a
 * focused Monaco instance can consume it. Save is always captured because it
 * follows the logically focused pane; every other app-global action is
 * captured only inside Monaco. Monaco-owned editor actions keep reaching the
 * editor instance itself.
 */
export function hotkeyNeedsCapture(action: HotkeyAction, monacoFocused: boolean): boolean {
  return action.id === 'editor.save' || (monacoFocused && action.editor !== true);
}

// --- merged bindings store (defaults overridden by the profile's settings) ---
let overrides: Record<string, string> = {};
const listeners = new Set<() => void>();
let bindingsSnapshot: Record<string, string> = mergeBindings();

function mergeBindings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of HOTKEY_ACTIONS) out[a.id] = overrides[a.id] || shellDefaultBinding(a);
  return out;
}

/** Called by `HotkeysHost` when the profile's hotkey overrides change. */
export function setHotkeyOverrides(next: Record<string, string> | undefined): void {
  overrides = next ?? {};
  bindingsSnapshot = mergeBindings();
  listeners.forEach((l) => l());
}

/** The effective binding for an action (override, else default). */
export const hotkeyBinding = (id: string): string => bindingsSnapshot[id] ?? '';

/** action-id for a given binding string, or undefined — for the dispatcher. */
export function actionForBinding(binding: string): string | undefined {
  for (const [id, b] of Object.entries(bindingsSnapshot)) if (b === binding) return id;
  return undefined;
}

/**
 * Whether a focused terminal keeps a chord even though an app shortcut uses
 * it. On a Windows client the defaults written for ⌘ use Ctrl, so a plain
 * Ctrl+letter (Ctrl+K, Ctrl+W, Ctrl+T, Ctrl+B, Ctrl+N…) would otherwise take
 * the control characters shells and agents read: readline's Ctrl+K and
 * Ctrl+W, PSReadLine's Ctrl+R, an agent's Ctrl+T or Ctrl+B. Those chords stay
 * with the terminal; app shortcuts with Shift or Alt still win, as anywhere
 * else in the app. Mac and Linux clients keep every rule as before.
 */
export function terminalKeepsChord(
  binding: string,
  client: ClientPlatform = CLIENT_PLATFORM,
): boolean {
  return client === 'windows' && /^ctrl\+Key[A-Z]$/.test(binding);
}

/** Whether a focused terminal keeps `action`'s chord: a terminal-owned action, or `terminalKeepsChord`. */
export function yieldsToTerminal(
  action: HotkeyAction,
  binding: string,
  client: ClientPlatform = CLIENT_PLATFORM,
): boolean {
  return action.deferInTerminal === true || terminalKeepsChord(binding, client);
}

/**
 * The app action a keydown in a focused terminal runs instead of reaching the
 * PTY, when "App shortcuts in terminals" is on (SPEC §11): a registered,
 * non-editor action the terminal does not keep (`yieldsToTerminal`), else
 * undefined and the terminal receives the key.
 */
export function terminalAppShortcut(
  binding: string | null,
  client: ClientPlatform = CLIENT_PLATFORM,
): string | undefined {
  if (binding === null) return undefined;
  const id = actionForBinding(binding);
  const action = id !== undefined ? ACTION_BY_ID.get(id) : undefined;
  if (id === undefined || action === undefined || action.editor) return undefined;
  if (yieldsToTerminal(action, binding, client)) return undefined;
  return handlers.has(id) ? id : undefined;
}

/**
 * An action's effective binding in the client's notation (`⌘K`, `Ctrl+K`),
 * re-rendering when the profile rebinds it. Every place that NAMES a shortcut
 * in UI copy — the top bar's palette hint, an empty pane, an empty session
 * list, the homescreen, the draft-save prompts — reads it from here rather
 * than hard-coding the default, so a rebind is honest everywhere at once
 * (SPEC §11). Actions deliberately left out of the registry (filetree ops,
 * terminal line-edits) still spell their fixed keys (`formatPrimaryShortcut`);
 * those cannot be rebound.
 */
export function useHotkeyLabel(id: string): string {
  return formatBinding(useHotkeyBindings()[id] ?? '');
}

/** Subscribe to the effective bindings (React) — re-render on rebind. */
export function useHotkeyBindings(): Record<string, string> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => bindingsSnapshot,
  );
}
