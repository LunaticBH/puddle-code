import { describe, expect, it, vi } from 'vitest';
import type { BaseWindow, MenuItem, MenuItemConstructorOptions } from 'electron';
import { WINDOWS_MINIMISE, WINDOWS_VIEW_MENU } from '../src/windows-menu.js';

/**
 * Electron's default accelerators on Windows for the roles these items use
 * (lib/browser/api/menu-item-roles.ts): what an item registers when it names
 * no accelerator of its own.
 */
const WINDOWS_ROLE_ACCELERATOR: Record<string, string | undefined> = {
  reload: 'CmdOrCtrl+R',
  forceReload: 'Shift+CmdOrCtrl+R',
  toggleDevTools: 'Ctrl+Shift+I',
  resetZoom: 'CommandOrControl+0',
  zoomIn: 'CommandOrControl+Plus',
  zoomOut: 'CommandOrControl+-',
  togglefullscreen: 'F11',
  minimize: 'CommandOrControl+M',
};

/** The accelerator an item would register with Windows, or undefined. */
function registered(item: MenuItemConstructorOptions): string | undefined {
  if (item.registerAccelerator === false) return undefined;
  const accelerator = item.accelerator ?? (item.role && WINDOWS_ROLE_ACCELERATOR[item.role]);
  return accelerator === undefined ? undefined : String(accelerator);
}

/** `CmdOrCtrl+R`, `Control+M`: Ctrl and one letter, the chords a terminal keeps. */
const PLAIN_CTRL_LETTER = /^(?:CmdOrCtrl|CommandOrControl|Ctrl|Control)\+[A-Z]$/i;

describe('Windows application menu', () => {
  it('registers no plain Ctrl+letter accelerator a focused terminal needs', () => {
    for (const item of [...WINDOWS_VIEW_MENU, WINDOWS_MINIMISE]) {
      const accelerator = registered(item);
      if (accelerator !== undefined) {
        expect(accelerator, item.role ?? item.label).not.toMatch(PLAIN_CTRL_LETTER);
      }
    }
  });

  it('keeps every View command, with Reload on F5', () => {
    expect(WINDOWS_VIEW_MENU.map((item) => item.role ?? item.type)).toEqual([
      'reload',
      'forceReload',
      'toggleDevTools',
      'separator',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'separator',
      'togglefullscreen',
    ]);
    expect(registered(WINDOWS_VIEW_MENU[0]!)).toBe('F5');
  });

  it('minimises the window the menu belongs to', () => {
    expect(WINDOWS_MINIMISE.role).toBeUndefined();
    expect(WINDOWS_MINIMISE.accelerator).toBeUndefined();
    const minimize = vi.fn();
    WINDOWS_MINIMISE.click!({} as MenuItem, { minimize } as unknown as BaseWindow, {} as never);
    expect(minimize).toHaveBeenCalledOnce();
    // No window (every window closed): nothing to do, and no throw.
    expect(() => WINDOWS_MINIMISE.click!({} as MenuItem, undefined, {} as never)).not.toThrow();
  });
});
