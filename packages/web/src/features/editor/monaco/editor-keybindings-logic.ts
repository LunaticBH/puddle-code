/**
 * Monaco-free logic for the editor keybindings (SPEC §8), split out so it is
 * unit-testable without importing the Monaco bundle (which touches `window` at
 * module load). The imperative registration lives in `editor-keybindings.ts`.
 */

/** The ⌥Z line-wrap toggle: flip the current `editorWordWrap` setting. */
export function nextWordWrap(current: boolean): boolean {
  return !current;
}
