import { describe, expect, it } from 'vitest';
import {
  actionForBinding,
  eventBinding,
  formatBinding,
  formatPrimaryShortcut,
  hotkeyNeedsCapture,
  HOTKEY_ACTIONS,
  setHotkeyOverrides,
  shellDefaultBinding,
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

describe('Windows and Linux clients', () => {
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

  it('spells bindings out off a Mac', () => {
    expect(formatBinding('ctrl+alt+KeyW', 'windows')).toBe('Ctrl+Alt+W');
    expect(formatBinding('ctrl+shift+KeyT', 'windows')).toBe('Ctrl+Shift+T');
    expect(formatBinding('meta+KeyK', 'windows')).toBe('Win+K');
    expect(formatBinding('meta+KeyK', 'other')).toBe('Super+K');
    expect(formatBinding('ctrl+Backquote', 'other')).toBe('Ctrl+`');
    expect(formatBinding('ctrl+Tab', 'windows')).toBe('Ctrl+Tab');
    expect(formatBinding('alt+Space', 'windows')).toBe('Alt+Space');
    expect(formatBinding('ctrl+Enter', 'other')).toBe('Ctrl+Enter');
    expect(formatBinding('', 'windows')).toBe('—');
    // A Mac keeps its glyphs.
    expect(formatBinding('ctrl+alt+KeyW', 'mac')).toBe('⌃⌥W');
    expect(formatBinding('shift+meta+KeyT', 'mac')).toBe('⇧⌘T');
  });

  it('labels fixed ⌘ shortcuts with Ctrl off a Mac', () => {
    expect(formatPrimaryShortcut('meta+KeyX', 'mac')).toBe('⌘X');
    expect(formatPrimaryShortcut('alt+shift+meta+KeyC', 'mac')).toBe('⌥⇧⌘C');
    expect(formatPrimaryShortcut('meta+KeyX', 'windows')).toBe('Ctrl+X');
    expect(formatPrimaryShortcut('alt+meta+KeyC', 'other')).toBe('Ctrl+Alt+C');
    expect(formatPrimaryShortcut('alt+shift+meta+KeyC', 'windows')).toBe('Ctrl+Alt+Shift+C');
  });

  it('never fires a shortcut for an AltGr character off a Mac', () => {
    // Windows reports AltGr as Ctrl+Alt: AltGr+E types € on a German layout.
    const altGr = keydown('KeyE', { ctrl: true, alt: true, altGraph: true });
    expect(eventBinding(altGr, 'windows')).toBeNull();
    expect(eventBinding(altGr, 'other')).toBeNull();
    // A real Ctrl+Alt+E is still a shortcut.
    expect(eventBinding(keydown('KeyE', { ctrl: true, alt: true }), 'windows')).toBe(
      'ctrl+alt+KeyE',
    );
  });

  it('leaves Mac key handling unchanged', () => {
    const option = keydown('KeyE', { alt: true, meta: true, altGraph: true });
    expect(eventBinding(option, 'mac')).toBe('alt+meta+KeyE');
  });
});
