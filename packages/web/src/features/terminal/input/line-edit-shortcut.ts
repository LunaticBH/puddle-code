type TerminalKeyEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'type'
>;

/**
 * Native macOS line-editing gestures translated to portable Readline/ZLE
 * controls. xterm 6 otherwise emits CSI 1;3D/C for Option+Arrow; stock macOS
 * zsh does not bind those sequences and inserts the visible `;3D`/`;3C` tail.
 *
 * Mac-only so Alt+Arrow keeps its standard modified-cursor encoding for TUIs
 * on other platforms. A null result leaves the event entirely to xterm.
 */
export function macLineEditSequence(event: TerminalKeyEvent): string | null {
  if (event.type !== 'keydown' || event.ctrlKey || event.shiftKey) return null;

  if (event.metaKey && !event.altKey) {
    switch (event.key) {
      case 'ArrowLeft':
        return '\x01'; // ⌘← → Ctrl-A: start of line
      case 'ArrowRight':
        return '\x05'; // ⌘→ → Ctrl-E: end of line
      case 'Backspace':
        return '\x15'; // ⌘⌫ → Ctrl-U: delete to start of line
      case 'Delete':
        return '\x0b'; // ⌘⌦ → Ctrl-K: delete to end of line
    }
  }

  if (event.altKey && !event.metaKey) {
    switch (event.key) {
      case 'ArrowLeft':
        return '\x1bb'; // ⌥← → Meta-B: previous word
      case 'ArrowRight':
        return '\x1bf'; // ⌥→ → Meta-F: next word
    }
  }

  return null;
}
