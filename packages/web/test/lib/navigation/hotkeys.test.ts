import { describe, expect, it } from 'vitest';
import {
  actionForBinding,
  eventBinding,
  formatBinding,
  formatPrimaryShortcut,
  hotkeyNeedsCapture,
  HOTKEY_ACTIONS,
  registerHotkey,
  setHotkeyOverrides,
  shellDefaultBinding,
  terminalAppShortcut,
  terminalKeepsChord,
  yieldsToTerminal,
} from '../../../src/lib/navigation/hotkeys';

const byId = (id: string) => HOTKEY_ACTIONS.find((a) => a.id === id)!;

/** A keydown as the DOM would report it (`eventBinding` reads only these). */
const keydown = (
  code: string,
  mods: Partial<Record<'ctrl' | 'alt' | 'shift' | 'meta' | 'altGraph', true>>,
) =>
  ({
    code,
    ctrlKey: mods.ctrl === true,
    altKey: mods.alt === true,
    shiftKey: mods.shift === true,
    metaKey: mods.meta === true,
    getModifierState: (key: string) => key === 'AltGraph' && mods.altGraph === true,
  }) as KeyboardEvent;

describe('shellDefaultBinding', () => {
  it('forks the intuitive natives on desktop and keeps the web-safe set in a tab', () => {
    expect(shellDefaultBinding(byId('tab.close'), true)).toBe('meta+KeyW');
    expect(shellDefaultBinding(byId('tab.close'), false)).toBe('ctrl+alt+KeyW');
    expect(shellDefaultBinding(byId('sidebar.left'), true)).toBe('meta+KeyB');
    // The right sidebar pairs with it: ⌘B / ⇧⌘B. ⌥⌘B is Open Worktrees.
    expect(shellDefaultBinding(byId('sidebar.right'), true)).toBe('shift+meta+KeyB');
    expect(shellDefaultBinding(byId('sidebar.right'), false)).toBe('alt+meta+Period');
    expect(shellDefaultBinding(byId('nav.worktrees'), true)).toBe('alt+meta+KeyB');
    expect(shellDefaultBinding(byId('session.newAgent'), true)).toBe('meta+KeyT');
    // Close window and reopen-tab dodge what the browser reserves for itself
    // (⌘W closes the tab, ⇧⌘T reopens the browser's own last one). Modifiers in
    // canonical order — `meta+shift+…` would read the same in the panel and
    // never fire.
    expect(shellDefaultBinding(byId('window.close'), true)).toBe('shift+meta+KeyW');
    expect(shellDefaultBinding(byId('window.close'), false)).toBe('meta+KeyW');
    expect(shellDefaultBinding(byId('tab.reopen'), true)).toBe('shift+meta+KeyT');
    expect(shellDefaultBinding(byId('tab.reopen'), false)).toBe('ctrl+alt+KeyT');
    // ⌘N is native new-thing muscle memory; the shell's New Window moved to
    // ⇧⌘N for it. A browser tab can never see ⌘N, hence the ⌃⌥ web default.
    expect(shellDefaultBinding(byId('tab.newUntitled'), true)).toBe('meta+KeyN');
    expect(shellDefaultBinding(byId('tab.newUntitled'), false)).toBe('ctrl+alt+KeyN');
    // an action without a desktop fork uses the one default everywhere
    expect(shellDefaultBinding(byId('palette.toggle'), true)).toBe('meta+KeyK');
    expect(shellDefaultBinding(byId('palette.toggle'), false)).toBe('meta+KeyK');
  });

  it('neither default set contains an internal conflict', () => {
    for (const desktop of [false, true]) {
      const bindings = HOTKEY_ACTIONS.map((a) => shellDefaultBinding(a, desktop));
      expect(new Set(bindings).size).toBe(bindings.length);
    }
  });

  it('desktop forks format to the intended Mac glyphs', () => {
    expect(formatBinding(shellDefaultBinding(byId('tab.close'), true))).toBe('⌘W');
    expect(formatBinding(shellDefaultBinding(byId('sidebar.left'), true))).toBe('⌘B');
    expect(formatBinding(shellDefaultBinding(byId('session.newAgent'), true))).toBe('⌘T');
    // Apple's modifier order (⌃⌥⇧⌘) falls out of the canonical string itself.
    expect(formatBinding(shellDefaultBinding(byId('window.close'), true))).toBe('⇧⌘W');
    expect(formatBinding(shellDefaultBinding(byId('tab.reopen'), true))).toBe('⇧⌘T');
    expect(formatBinding(shellDefaultBinding(byId('tab.reopen'), false))).toBe('⌃⌥T');
  });
});

describe('canonical bindings', () => {
  const MOD_ORDER = ['ctrl', 'alt', 'shift', 'meta'];

  /**
   * A default written out of order is INVISIBLE: nothing rejects it, the
   * settings panel renders it, and only the keypress fails — the dispatcher
   * compares `eventBinding`'s canonical string for equality, and
   * `meta+shift+KeyT` never equals the `shift+meta+KeyT` a ⇧⌘T keydown makes.
   * (That shipped once, in the first cut of close-window / reopen-tab.)
   */
  it('every default in both shells lists its modifiers in canonical order', () => {
    for (const action of HOTKEY_ACTIONS) {
      for (const desktop of [false, true]) {
        const parts = shellDefaultBinding(action, desktop).split('+');
        parts.pop(); // the KeyboardEvent.code
        const ranks = parts.map((m) => MOD_ORDER.indexOf(m));
        expect(ranks, `${action.id} (${desktop ? 'desktop' : 'web'})`).not.toContain(-1);
        expect(ranks, `${action.id} (${desktop ? 'desktop' : 'web'})`).toEqual(
          [...ranks].sort((a, b) => a - b),
        );
      }
    }
  });

  it('a real keydown resolves to the action holding that default', () => {
    // The dispatcher's own path: keydown → canonical string → action id.
    setHotkeyOverrides(undefined);
    expect(eventBinding(keydown('KeyK', { meta: true }))).toBe('meta+KeyK');
    expect(actionForBinding(eventBinding(keydown('KeyK', { meta: true }))!)).toBe('palette.toggle');
    // ⇧⌘T / ⇧⌘W are the desktop defaults, so they resolve in a desktop window.
    setHotkeyOverrides({
      'tab.reopen': shellDefaultBinding(byId('tab.reopen'), true),
      'window.close': shellDefaultBinding(byId('window.close'), true),
    });
    expect(actionForBinding(eventBinding(keydown('KeyT', { meta: true, shift: true }))!)).toBe(
      'tab.reopen',
    );
    expect(actionForBinding(eventBinding(keydown('KeyW', { meta: true, shift: true }))!)).toBe(
      'window.close',
    );
    setHotkeyOverrides(undefined);
  });
});

describe('capture-phase ownership', () => {
  it('takes app-global shortcuts before Monaco can consume them', () => {
    expect(hotkeyNeedsCapture(byId('palette.toggle'), true)).toBe(true);
    expect(hotkeyNeedsCapture(byId('tab.close'), true)).toBe(true);
    expect(hotkeyNeedsCapture(byId('palette.toggle'), false)).toBe(false);
  });

  it('leaves Monaco-owned editor actions in Monaco while always capturing save', () => {
    expect(hotkeyNeedsCapture(byId('editor.wordWrap'), true)).toBe(false);
    expect(hotkeyNeedsCapture(byId('editor.save'), true)).toBe(true);
    expect(hotkeyNeedsCapture(byId('editor.save'), false)).toBe(true);
  });
});

describe('Windows clients', () => {
  it('moves every default written for ⌘ onto Ctrl on Windows, in canonical order', () => {
    expect(shellDefaultBinding(byId('palette.toggle'), false, 'windows')).toBe('ctrl+KeyK');
    expect(shellDefaultBinding(byId('editor.save'), false, 'windows')).toBe('ctrl+KeyS');
    expect(shellDefaultBinding(byId('nav.files'), false, 'windows')).toBe('ctrl+alt+KeyE');
    expect(shellDefaultBinding(byId('sidebar.right'), false, 'windows')).toBe('ctrl+alt+Period');
    expect(shellDefaultBinding(byId('tab.close'), true, 'windows')).toBe('ctrl+KeyW');
    expect(shellDefaultBinding(byId('tab.reopen'), true, 'windows')).toBe('ctrl+shift+KeyT');
    // Defaults that never used ⌘ are untouched.
    expect(shellDefaultBinding(byId('tab.close'), false, 'windows')).toBe('ctrl+alt+KeyW');
    expect(shellDefaultBinding(byId('tab.next'), true, 'windows')).toBe('ctrl+Tab');
  });

  it('keeps Mac and Linux defaults exactly as written', () => {
    for (const client of ['mac', 'other'] as const) {
      for (const action of HOTKEY_ACTIONS) {
        for (const desktop of [false, true]) {
          const written =
            desktop && action.desktopBinding ? action.desktopBinding : action.defaultBinding;
          expect(shellDefaultBinding(action, desktop, client)).toBe(written);
        }
      }
    }
  });

  it('gives the Windows default sets no internal conflict', () => {
    for (const desktop of [false, true]) {
      const bindings = HOTKEY_ACTIONS.map((a) => shellDefaultBinding(a, desktop, 'windows'));
      expect(new Set(bindings).size).toBe(bindings.length);
    }
  });

  it('spells bindings out on Windows', () => {
    expect(formatBinding('ctrl+alt+KeyW', 'windows')).toBe('Ctrl+Alt+W');
    expect(formatBinding('ctrl+shift+KeyT', 'windows')).toBe('Ctrl+Shift+T');
    expect(formatBinding('meta+KeyK', 'windows')).toBe('Win+K');
    expect(formatBinding('ctrl+Backquote', 'windows')).toBe('Ctrl+`');
    expect(formatBinding('ctrl+Tab', 'windows')).toBe('Ctrl+Tab');
    expect(formatBinding('alt+Space', 'windows')).toBe('Alt+Space');
    expect(formatBinding('ctrl+Enter', 'windows')).toBe('Ctrl+Enter');
    expect(formatBinding('', 'windows')).toBe('—');
  });

  it('keeps the glyph labels on Mac and Linux clients', () => {
    for (const client of ['mac', 'other'] as const) {
      expect(formatBinding('ctrl+alt+KeyW', client)).toBe('⌃⌥W');
      expect(formatBinding('shift+meta+KeyT', client)).toBe('⇧⌘T');
      expect(formatBinding('meta+KeyK', client)).toBe('⌘K');
      expect(formatBinding('ctrl+Tab', client)).toBe('⌃⇥');
      expect(formatBinding('alt+Space', client)).toBe('⌥␣');
      expect(formatBinding('', client)).toBe('—');
    }
  });

  it('labels fixed ⌘ shortcuts with Ctrl on Windows only', () => {
    expect(formatPrimaryShortcut('meta+KeyX', 'windows')).toBe('Ctrl+X');
    expect(formatPrimaryShortcut('alt+meta+KeyC', 'windows')).toBe('Ctrl+Alt+C');
    expect(formatPrimaryShortcut('alt+shift+meta+KeyC', 'windows')).toBe('Ctrl+Alt+Shift+C');
    // The explorer's historical labels, unchanged on Mac and Linux.
    for (const client of ['mac', 'other'] as const) {
      expect(formatPrimaryShortcut('meta+KeyX', client)).toBe('⌘X');
      expect(formatPrimaryShortcut('alt+meta+KeyC', client)).toBe('⌥⌘C');
      expect(formatPrimaryShortcut('alt+shift+meta+KeyC', client)).toBe('⌥⇧⌘C');
    }
  });

  it('never fires a shortcut for an AltGr character on Windows', () => {
    // Windows reports AltGr as Ctrl+Alt: AltGr+E types € on a German layout.
    const altGr = keydown('KeyE', { ctrl: true, alt: true, altGraph: true });
    expect(eventBinding(altGr, 'windows')).toBeNull();
    // A real Ctrl+Alt+E is still a shortcut.
    expect(eventBinding(keydown('KeyE', { ctrl: true, alt: true }), 'windows')).toBe(
      'ctrl+alt+KeyE',
    );
  });

  it('leaves Mac and Linux key handling unchanged', () => {
    const option = keydown('KeyE', { alt: true, meta: true, altGraph: true });
    expect(eventBinding(option, 'mac')).toBe('alt+meta+KeyE');
    const linuxAltGr = keydown('KeyE', { ctrl: true, alt: true, altGraph: true });
    expect(eventBinding(linuxAltGr, 'other')).toBe('ctrl+alt+KeyE');
  });
});

describe('plain Ctrl+letter in a Windows terminal', () => {
  it('keeps exactly the plain Ctrl+letter chords for the terminal', () => {
    for (const code of ['KeyA', 'KeyB', 'KeyK', 'KeyN', 'KeyR', 'KeyS', 'KeyT', 'KeyW']) {
      expect(terminalKeepsChord(`ctrl+${code}`, 'windows'), code).toBe(true);
    }
    // Shift or Alt makes it an app chord again; so does any key but a letter.
    expect(terminalKeepsChord('ctrl+shift+KeyT', 'windows')).toBe(false);
    expect(terminalKeepsChord('ctrl+alt+KeyE', 'windows')).toBe(false);
    expect(terminalKeepsChord('ctrl+Tab', 'windows')).toBe(false);
    expect(terminalKeepsChord('ctrl+Backquote', 'windows')).toBe(false);
    expect(terminalKeepsChord('ctrl+Digit1', 'windows')).toBe(false);
    expect(terminalKeepsChord('ctrl+meta+KeyK', 'windows')).toBe(false);
  });

  it('never applies on Mac or Linux clients', () => {
    for (const client of ['mac', 'other'] as const) {
      expect(terminalKeepsChord('ctrl+KeyK', client)).toBe(false);
      expect(terminalKeepsChord('ctrl+KeyW', client)).toBe(false);
      expect(yieldsToTerminal(byId('palette.toggle'), 'ctrl+KeyK', client)).toBe(false);
    }
  });

  it('still yields actions the registry marks terminal-owned', () => {
    const owned = { ...byId('session.newTerminal'), deferInTerminal: true };
    for (const client of ['mac', 'other', 'windows'] as const) {
      expect(yieldsToTerminal(owned, 'ctrl+Backquote', client)).toBe(true);
    }
  });

  it('sends Ctrl+letter shortcuts to the terminal and Ctrl+Shift or Ctrl+Alt ones to the app', () => {
    // The desktop shell's Windows defaults, as a Windows window merges them.
    setHotkeyOverrides(
      Object.fromEntries(
        HOTKEY_ACTIONS.map((a) => [a.id, shellDefaultBinding(a, true, 'windows')]),
      ),
    );
    const ids = [
      'palette.toggle',
      'tab.close',
      'tab.reopen',
      'tab.next',
      'sidebar.left',
      'nav.files',
    ];
    const unregister = ids.map((id) => registerHotkey(id, () => undefined));
    const chord = (code: string, mods: Parameters<typeof keydown>[1]) =>
      terminalAppShortcut(eventBinding(keydown(code, mods), 'windows'), 'windows');
    try {
      // Ctrl+K (kill line), Ctrl+W (rub out a word), Ctrl+B: the terminal's.
      expect(chord('KeyK', { ctrl: true })).toBeUndefined();
      expect(chord('KeyW', { ctrl: true })).toBeUndefined();
      expect(chord('KeyB', { ctrl: true })).toBeUndefined();
      // Ctrl+Shift+T, Ctrl+Alt+E and Ctrl+Tab still reach the app.
      expect(chord('KeyT', { ctrl: true, shift: true })).toBe('tab.reopen');
      expect(chord('KeyE', { ctrl: true, alt: true })).toBe('nav.files');
      expect(chord('Tab', { ctrl: true })).toBe('tab.next');
    } finally {
      unregister.forEach((off) => off());
      setHotkeyOverrides(undefined);
    }
  });

  it('keeps the Mac and Linux terminal rule exactly as before', () => {
    // ⌘K and the desktop ⌃⇥ are app shortcuts over a focused terminal.
    setHotkeyOverrides({ 'tab.next': shellDefaultBinding(byId('tab.next'), true) });
    const unregister = ['palette.toggle', 'tab.next'].map((id) =>
      registerHotkey(id, () => undefined),
    );
    try {
      for (const client of ['mac', 'other'] as const) {
        expect(terminalAppShortcut('meta+KeyK', client)).toBe('palette.toggle');
        expect(terminalAppShortcut('ctrl+Tab', client)).toBe('tab.next');
        // A chord no action holds, an editor action, or no key at all: the terminal's.
        expect(terminalAppShortcut('ctrl+KeyK', client)).toBeUndefined();
        expect(terminalAppShortcut('meta+KeyS', client)).toBeUndefined();
        expect(terminalAppShortcut(null, client)).toBeUndefined();
      }
      // An action with no live handler leaves the key to the terminal too.
      unregister[0]!();
      expect(terminalAppShortcut('meta+KeyK', 'mac')).toBeUndefined();
    } finally {
      unregister.forEach((off) => off());
      setHotkeyOverrides(undefined);
    }
  });
});
