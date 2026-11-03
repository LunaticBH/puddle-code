/**
 * Monaco-free logic for the editor keybindings (SPEC §8), split out so it is
 * unit-testable without importing the Monaco bundle (which touches `window` at
 * module load). The imperative registration lives in `editor-keybindings.ts`.
 */

import type { ClientPlatform } from '../../../lib/client-platform';

/** The ⌥Z line-wrap toggle: flip the current `editorWordWrap` setting. */
export function nextWordWrap(current: boolean): boolean {
  return !current;
}

/** The `monaco.KeyMod` member a canonical hotkey modifier becomes. */
export type MonacoModifier = 'CtrlCmd' | 'WinCtrl' | 'Alt' | 'Shift';

/**
 * Monaco's `CtrlCmd` is ⌘ on a Mac and Ctrl elsewhere; its `WinCtrl` is Ctrl on
 * a Mac and the Windows/Super key elsewhere. Mac and Linux clients keep the
 * historical mapping (`meta` → CtrlCmd, `ctrl` → WinCtrl). A Windows client's
 * defaults already name Ctrl (`shellDefaultBinding`), so there each modifier
 * maps to the key it names and Monaco agrees with the DOM dispatcher.
 */
export function monacoModifier(modifier: string, client: ClientPlatform): MonacoModifier | null {
  const windows = client === 'windows';
  switch (modifier) {
    case 'meta':
      return windows ? 'WinCtrl' : 'CtrlCmd';
    case 'ctrl':
      return windows ? 'CtrlCmd' : 'WinCtrl';
    case 'alt':
      return 'Alt';
    case 'shift':
      return 'Shift';
    default:
      return null;
  }
}
