import type { IBuffer } from '@xterm/xterm';

export interface CellPosition {
  row: number;
  col: number;
}

export interface MappedRow {
  text: string;
  cells: CellPosition[];
  isWrapped: boolean;
}

export interface BufferLinkCandidate<T> {
  candidate: T;
  start: CellPosition;
  /** Inclusive cell containing the token's final character. */
  end: CellPosition;
  text: string;
}

const MAX_ROWS = 32;
const MAX_LENGTH = 2048;

/** Map UTF-16 offsets as we read, before removing any TUI indentation. */
export function readRow(buffer: IBuffer, row: number, cols: number): MappedRow | null {
  const line = buffer.getLine(row);
  if (!line) return null;
  const cell = buffer.getNullCell();
  let text = '';
  const cells: CellPosition[] = [];
  for (let col = 0; col < Math.min(cols, line.length); col++) {
    if (!line.getCell(col, cell) || cell.getWidth() === 0) continue;
    // xterm leaves an empty last cell when a wide glyph wraps to the next row.
    if (col === cols - 1 && cell.getChars() === '') {
      const next = buffer.getLine(row + 1);
      if (next?.isWrapped && next.getCell(0)?.getWidth() === 2) continue;
    }
    const chars = cell.getChars() || ' ';
    text += chars;
    for (let i = 0; i < chars.length; i++) cells.push({ row, col });
  }
  return { text, cells, isWrapped: line.isWrapped };
}

function sliceRow(row: MappedRow, start: number, end: number): MappedRow {
  return { ...row, text: row.text.slice(start, end), cells: row.cells.slice(start, end) };
}

/**
 * Follow soft wrapping and bounded TUI hard wraps, retaining the original cell
 * for every character. Arithmetic using string lengths cannot map indentation,
 * wide glyphs or combining characters back onto the terminal reliably.
 */
export function findBufferLinkCandidates<T extends { start: number; end: number }>(
  buffer: IBuffer,
  row0: number,
  cols: number,
  findCandidates: (text: string) => T[],
  hardContinuation: (previous: MappedRow, next: MappedRow, cols: number, text: string) => boolean,
): BufferLinkCandidate<T>[] {
  if (row0 < 0 || cols < 1) return [];
  const first = Math.max(0, row0 - MAX_ROWS + 1);
  const rows = new Map<number, MappedRow>();
  for (let row = first; row < row0 + MAX_ROWS; row++) {
    const mapped = readRow(buffer, row, cols);
    if (!mapped) break;
    rows.set(row, mapped);
  }
  const seen = new Set<string>();
  const out: BufferLinkCandidate<T>[] = [];

  for (const hardWraps of [true, false]) {
    // Try each hard line as a start so an unrelated preceding line cannot
    // swallow the start of a real link. Soft continuations share one start.
    for (let startRow = first; startRow <= row0; startRow++) {
      if (rows.get(startRow)?.isWrapped && startRow > first) continue;
      let text = '';
      const cells: CellPosition[] = [];
      for (let row = startRow; row < startRow + MAX_ROWS; row++) {
        const current = rows.get(row);
        if (!current) break;
        const previous = rows.get(row - 1);
        if (
          row > startRow &&
          !current.isWrapped &&
          !(hardWraps && previous && hardContinuation(previous, current, cols, text))
        )
          break;

        const next = rows.get(row + 1);
        const start =
          row > startRow && !current.isWrapped
            ? current.text.length - current.text.trimStart().length
            : 0;
        // Preserve whitespace at soft boundaries: trimming it would join
        // separate words and shift every coordinate on the following row.
        const end = next?.isWrapped ? current.text.length : current.text.trimEnd().length;
        const part = sliceRow(current, start, end);
        if (text.length + part.text.length > MAX_LENGTH) break;
        text += part.text;
        cells.push(...part.cells);

        // Keep shorter, validated alternatives if the next row is unrelated.
        if (row < row0) continue;
        for (const candidate of findCandidates(text)) {
          const startCell = cells[candidate.start];
          const endCell = cells[candidate.end - 1];
          if (!startCell || !endCell || startCell.row > row0 || endCell.row < row0) continue;
          const key = `${text.slice(candidate.start, candidate.end)}\0${startCell.row}:${startCell.col}-${endCell.row}:${endCell.col}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const endWidth = buffer.getLine(endCell.row)?.getCell(endCell.col)?.getWidth() ?? 1;
          out.push({
            candidate,
            start: startCell,
            end: { row: endCell.row, col: endCell.col + Math.max(1, endWidth) - 1 },
            text: text.slice(candidate.start, candidate.end),
          });
        }
      }
    }
  }
  // xterm keeps the first overlapping result: favour the complete link over
  // a prefix that also happens to be a valid target.
  return out.sort((a, b) => b.text.length - a.text.length);
}
