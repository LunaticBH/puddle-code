interface XtermParams {
  params: ArrayLike<number>;
}

interface XtermInputHandler {
  _activeBuffer: {
    ybase: number;
    savedY: number;
    scrollTop: number;
    scrollBottom: number;
  };
  _bufferService: {
    scroll(attributes: unknown): void;
  };
  _dirtyRowTracker: {
    markRangeDirty(start: number, end: number): void;
  };
  _eraseAttrData(): unknown;
  scrollUp(params: XtermParams): boolean;
}

const patchedHandlers = new WeakSet<object>();

function inputHandlerOf(terminal: unknown): XtermInputHandler {
  const core = (terminal as { _core?: unknown })._core;
  const input = (core as { _inputHandler?: unknown } | undefined)?._inputHandler;
  const candidate = input as Partial<XtermInputHandler> | undefined;
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof candidate?.scrollUp !== 'function' ||
    typeof candidate._eraseAttrData !== 'function' ||
    typeof candidate._bufferService?.scroll !== 'function' ||
    typeof candidate._dirtyRowTracker?.markRangeDirty !== 'function'
  ) {
    throw new Error('xterm scrollback internals do not match the pinned 6.0.0 release');
  }
  return input as XtermInputHandler;
}

/**
 * Preserve rows scrolled out by CSI S when the scroll region starts at row 1.
 *
 * xterm 6.0.0 splice-deletes those rows instead of sending them to scrollback,
 * unlike the equivalent line-feed path. Agent TUIs use this command while
 * streaming into a partial-height region, which makes transcript lines vanish.
 * This is the narrowly scoped upstream fix from xtermjs/xterm.js#6011; remove
 * it once the exact-pinned headless/browser pair includes that fix.
 */
export function preserveXtermScrollUp(terminal: unknown): void {
  const input = inputHandlerOf(terminal);
  if (patchedHandlers.has(input)) return;
  patchedHandlers.add(input);

  const originalScrollUp = input.scrollUp.bind(input);
  input.scrollUp = (params) => {
    if (input._activeBuffer.scrollTop !== 0) return originalScrollUp(params);

    let lines = params.params[0] || 1;
    while (lines--) {
      const oldBase = input._activeBuffer.ybase;
      input._bufferService.scroll(input._eraseAttrData());
      // Keep saved cursors on the same visible row as the viewport base moves.
      input._activeBuffer.savedY += input._activeBuffer.ybase - oldBase;
    }
    input._dirtyRowTracker.markRangeDirty(
      input._activeBuffer.scrollTop,
      input._activeBuffer.scrollBottom,
    );
    return true;
  };
}
