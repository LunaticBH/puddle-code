import { describe, expect, it } from 'vitest';
import {
  actionForBinding,
  eventBinding,
  formatBinding,
  hotkeyNeedsCapture,
  HOTKEY_ACTIONS,
  setHotkeyOverrides,
  shellDefaultBinding,
} from '../../../src/lib/navigation/hotkeys';

const byId = (id: string) => HOTKEY_ACTIONS.find((a) => a.id === id)!;

/** A keydown as the DOM would report it (`eventBinding` reads only these). */
const keydown = (code: string, mods: Partial<Record<'ctrl' | 'alt' | 'shift' | 'meta', true>>) =>
  ({
    code,
    ctrlKey: mods.ctrl === true,
    altKey: mods.alt === true,
    shiftKey: mods.shift === true,
    metaKey: mods.meta === true,
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
