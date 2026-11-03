/** The subset of KeyboardEvent the copy-chord test needs (pure, unit-testable). */
export interface CopyKeyEvent {
  type: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The terminal's copy chord: ⌘C on Mac, Ctrl+Shift+C elsewhere (the
 * terminal-emulator convention). Ctrl-C also copies when there is a selection;
 * without one it remains the application's interrupt/copy key.
 */
export function isCopyShortcut(e: CopyKeyEvent, isMac: boolean, hasSelection = false): boolean {
  if (e.type !== 'keydown') return false;
  if (hasSelection && isControlC(e)) return true;
  if (isMac)
    return e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c';
  return e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'c';
}

export function isControlC(e: CopyKeyEvent): boolean {
  return (
    e.type === 'keydown' &&
    e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey &&
    e.key.toLowerCase() === 'c'
  );
}
