import type { MenuItemConstructorOptions } from 'electron';

/**
 * Where the Windows application menu departs from Electron's role defaults.
 * On a Windows client the renderer's shortcuts use Ctrl (SPEC §11), and a
 * focused terminal keeps every plain Ctrl+letter chord: shells and agents
 * read Ctrl+R, Ctrl+M, Ctrl+W, Ctrl+T and the rest as control characters. So,
 * as the macOS menu yields ⌘W/⌘N/⌘T to the renderer, no Windows menu command
 * holds a plain Ctrl+letter accelerator:
 *
 * - View → Reload moves from Ctrl+R to F5, the Windows refresh key (Force
 *   Reload keeps Ctrl+Shift+R);
 * - Window → Minimise drops Ctrl+M, a macOS convention (Windows uses Win+Down).
 *
 * The Edit menu keeps Ctrl+Z/Y/X/C/V/A: they ARE the text-editing commands,
 * and Electron runs a Windows accelerator only for a key the page left
 * unhandled, so a terminal that consumes Ctrl+C or Ctrl+A still receives it.
 * Linux and macOS keep the role menus exactly as before.
 */

/** Electron's `viewMenu` role on Windows and Linux, with Reload on F5. */
export const WINDOWS_VIEW_MENU: MenuItemConstructorOptions[] = [
  { role: 'reload', accelerator: 'F5' },
  { role: 'forceReload' },
  { role: 'toggleDevTools' },
  { type: 'separator' },
  { role: 'resetZoom' },
  { role: 'zoomIn' },
  { role: 'zoomOut' },
  { type: 'separator' },
  { role: 'togglefullscreen' },
];

/** Window → Minimise with no accelerator: the `minimize` role would register Ctrl+M. */
export const WINDOWS_MINIMISE: MenuItemConstructorOptions = {
  label: 'Minimise',
  click: (_item, window) => window?.minimize(),
};
