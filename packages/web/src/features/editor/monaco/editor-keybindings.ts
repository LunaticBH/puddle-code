import { clientSettings, updateClientSettings } from '../../../lib/settings/client-settings';
import { hotkeyBinding } from '../../../lib/navigation/hotkeys';
import { nextWordWrap } from './editor-keybindings-logic';
import { monaco } from './monaco-setup';

/**
 * Translate one canonical hotkey binding (`shift+meta+KeyS`) into a Monaco
 * keybinding number, or null if a code has no Monaco equivalent. `meta` maps to
 * CtrlCmd (⌘ on Mac), `ctrl` to WinCtrl.
 */
function toMonacoKeybinding(binding: string): number | null {
  const parts = binding.split('+');
  const code = parts.pop() ?? '';
  let mods = 0;
  for (const p of parts) {
    if (p === 'meta') mods |= monaco.KeyMod.CtrlCmd;
    else if (p === 'ctrl') mods |= monaco.KeyMod.WinCtrl;
    else if (p === 'alt') mods |= monaco.KeyMod.Alt;
    else if (p === 'shift') mods |= monaco.KeyMod.Shift;
  }
  const key = /^Key[A-Z]$/.test(code)
    ? (`Key${code.slice(3)}` as keyof typeof monaco.KeyCode)
    : /^Digit[0-9]$/.test(code)
      ? (`Digit${code.slice(5)}` as keyof typeof monaco.KeyCode)
      : (code as keyof typeof monaco.KeyCode);
  const kc = monaco.KeyCode[key];
  return typeof kc === 'number' ? mods | kc : null;
}

/**
 * Register puddle's Monaco keybindings on an editor instance (SPEC §8/§11), from
 * the customisable hotkey registry:
 *
 * - `editor.save` (default `⌘S`) — local fallback delegated to the buffer's
 *   save; the shell normally captures it first to honour logical pane focus.
 * - `editor.wordWrap` (default `⌥Z`) — flips the `editorWordWrap` client setting,
 *   which every open editor's `wordWrap` option is bound to, so the change
 *   applies live to all editors and persists (VSCode's view-toggle, made sticky).
 *
 * Bindings are read at editor-mount, so a rebind applies to newly opened editors.
 * Monaco's stock bindings (multi-cursor, `⌘/` comment, find/replace) are left as
 * they ship.
 */
export function registerEditorKeybindings(
  editor: monaco.editor.IStandaloneCodeEditor,
  opts: { onSave: () => void },
): void {
  const save = toMonacoKeybinding(hotkeyBinding('editor.save'));
  if (save !== null) editor.addCommand(save, () => opts.onSave());

  const wrap = toMonacoKeybinding(hotkeyBinding('editor.wordWrap'));
  editor.addAction({
    id: 'puddle.toggleWordWrap',
    label: 'Toggle Word Wrap',
    keybindings: wrap !== null ? [wrap] : [],
    run: () =>
      updateClientSettings({ editorWordWrap: nextWordWrap(clientSettings().editorWordWrap) }),
  });
}
