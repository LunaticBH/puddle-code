import type { Terminal } from '@xterm/xterm';
import { terminalTouchSelection } from './touch-selection';

const DRAG_THRESHOLD = 8;

/**
 * xterm 6.0.0 handles wheels but has no touch-scrolling handler. Own single-finger
 * drags on its screen; leave pinch zoom and the surrounding native scrollers alone.
 */
export function attachTerminalTouchScroll(
  terminal: Terminal,
  active: () => boolean,
  onScroll: () => void,
  onSelection: (text: string | null) => void,
): () => void {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) return () => {};
  const selection = terminalTouchSelection(terminal, screen, onSelection, onScroll);
  let hold: ReturnType<typeof setTimeout> | undefined;
  let gesture: {
    id: number;
    x: number;
    y: number;
    lastY: number;
    remainder: number;
    at: number;
    dragged: boolean;
    selecting: boolean;
  } | null = null;

  const reset = () => {
    clearTimeout(hold);
    selection.stop();
    gesture = null;
  };
  const start = (event: TouchEvent) => {
    reset();
    if (event.touches.length !== 1 || !active()) return;
    selection.clear();
    const touch = event.touches[0]!;
    gesture = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      lastY: touch.clientY,
      remainder: 0,
      at: performance.now(),
      dragged: false,
      selecting: false,
    };
    hold = setTimeout(() => {
      if (!gesture || !active()) return;
      gesture.selecting = true;
      selection.begin(gesture.x, gesture.y);
    }, 450);
  };
  const move = (event: TouchEvent) => {
    if (!gesture) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch?.identifier !== gesture.id || !active()) {
      reset();
      return;
    }
    if (gesture.selecting) {
      event.preventDefault();
      selection.extend(touch.clientX, touch.clientY);
      return;
    }
    if (!gesture.dragged) {
      if (Math.hypot(touch.clientX - gesture.x, touch.clientY - gesture.y) < DRAG_THRESHOLD) return;
      gesture.dragged = true;
      clearTimeout(hold);
    }
    // Even at the scrollback boundaries, a terminal drag must not pan the page.
    event.preventDefault();
    const bounds = screen.getBoundingClientRect();
    const cellHeight = bounds.height / terminal.rows;
    if (cellHeight <= 0) return;
    gesture.remainder += gesture.lastY - touch.clientY;
    gesture.lastY = touch.clientY;
    const lines = Math.trunc(gesture.remainder / cellHeight);
    if (lines === 0) return;
    gesture.remainder -= lines * cellHeight;
    onScroll();
    if (terminal.buffer.active.type === 'normal' && terminal.modes.mouseTrackingMode === 'none') {
      terminal.scrollLines(lines);
      return;
    }
    // Let xterm encode the application's chosen mouse protocol or alternate-screen
    // cursor keys. One event per row also avoids its wheel/trackpad acceleration.
    for (let line = 0; line < Math.abs(lines); line++) {
      screen.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaY: Math.sign(lines),
          clientX: Math.max(bounds.left, Math.min(bounds.right - 1, touch.clientX)),
          clientY: Math.max(bounds.top, Math.min(bounds.bottom - 1, touch.clientY)),
        }),
      );
    }
  };
  const end = (event: TouchEvent) => {
    if (gesture?.dragged || gesture?.selecting)
      event.preventDefault(); // suppress the emulated click after a swipe
    else if (gesture && active() && performance.now() - gesture.at < 300) terminal.focus();
    reset();
  };
  const contextMenu = (event: Event) => {
    if (!gesture || !active()) return;
    // Mobile browser callouts must not focus xterm or replace our held selection.
    event.preventDefault();
    event.stopPropagation();
  };
  screen.addEventListener('contextmenu', contextMenu, true);
  screen.addEventListener('touchstart', start, { passive: true });
  screen.addEventListener('touchmove', move, { passive: false });
  screen.addEventListener('touchend', end, { passive: false });
  screen.addEventListener('touchcancel', reset);
  return () => {
    screen.removeEventListener('touchstart', start);
    screen.removeEventListener('touchmove', move);
    screen.removeEventListener('touchend', end);
    screen.removeEventListener('touchcancel', reset);
    screen.removeEventListener('contextmenu', contextMenu, true);
    reset();
    selection.dispose();
  };
}
