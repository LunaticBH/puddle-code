import type { Terminal } from '@xterm/xterm';

/** Local cell selection never sends mouse reports or input to the running application. */
export function terminalTouchSelection(
  terminal: Terminal,
  screen: HTMLElement,
  changed: (text: string | null) => void,
  scrolled: () => void,
) {
  let anchor: { start: number; end: number } | null = null;
  let owned = false;
  let frame = 0;
  let pointer: { x: number; y: number } | null = null;
  let lastScroll = 0;

  const cellAt = (x: number, y: number) => {
    const bounds = screen.getBoundingClientRect();
    const column = Math.max(
      0,
      Math.min(terminal.cols - 1, Math.floor((x - bounds.left) / (bounds.width / terminal.cols))),
    );
    const row =
      terminal.buffer.active.viewportY +
      Math.max(
        0,
        Math.min(terminal.rows - 1, Math.floor((y - bounds.top) / (bounds.height / terminal.rows))),
      );
    const line = terminal.buffer.active.getLine(row);
    // A wide glyph's second cell belongs to the first, including in reversed drags.
    const startColumn = column > 0 && line?.getCell(column)?.getWidth() === 0 ? column - 1 : column;
    return {
      row,
      column: startColumn,
      width: Math.max(1, line?.getCell(startColumn)?.getWidth() ?? 1),
    };
  };
  const update = () => {
    if (!anchor || !pointer) return;
    const cell = cellAt(pointer.x, pointer.y);
    const index = cell.row * terminal.cols + cell.column;
    const start = Math.min(anchor.start, index);
    const end = Math.max(anchor.end, index + cell.width);
    terminal.select(start % terminal.cols, Math.floor(start / terminal.cols), end - start);
    changed(terminal.getSelection());
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    pointer = null;
  };
  const autoScroll = (now: number) => {
    frame = 0;
    if (!pointer) return;
    const bounds = screen.getBoundingClientRect();
    // A selection on the first/last visible row must stay still. Scroll only
    // when the finger pulls beyond the screen into earlier/later history.
    const direction = pointer.y < bounds.top ? -1 : pointer.y >= bounds.bottom ? 1 : 0;
    if (direction && now - lastScroll >= 50 && terminal.buffer.active.type === 'normal') {
      lastScroll = now;
      scrolled();
      terminal.scrollLines(direction);
      update();
    }
    frame = requestAnimationFrame(autoScroll);
  };
  const selection = terminal.onSelectionChange(() => {
    if (owned) changed(terminal.getSelection());
  });
  const clear = () => {
    stop();
    anchor = null;
    owned = false;
    terminal.clearSelection();
    changed(null);
  };
  return {
    begin(x: number, y: number) {
      const cell = cellAt(x, y);
      const line = terminal.buffer.active.getLine(cell.row);
      let start = cell.column;
      let end = cell.column + cell.width;
      const wordCell = (column: number) => {
        const entry = line?.getCell(column);
        return entry && (entry.getWidth() === 0 || /\S/u.test(entry.getChars()));
      };
      if (wordCell(start)) {
        while (start > 0 && wordCell(start - 1)) start--;
        while (end < terminal.cols && wordCell(end)) end++;
      }
      anchor = { start: cell.row * terminal.cols + start, end: cell.row * terminal.cols + end };
      owned = true;
      terminal.select(start, cell.row, end - start);
      changed(terminal.getSelection());
    },
    extend(x: number, y: number) {
      pointer = { x, y };
      update();
      if (!frame) frame = requestAnimationFrame(autoScroll);
    },
    stop,
    clear,
    dispose() {
      stop();
      selection.dispose();
    },
  };
}
