import type { IBuffer } from '@xterm/xterm';
import { matchMathAt } from '../../editor/previews/markdown/math-delimiters';
import { readRow, type CellPosition } from '../links/link-buffer';

export interface TerminalRichBlock {
  kind: 'mermaid' | 'math';
  source: string;
  display: boolean;
  start: CellPosition;
  end: CellPosition;
}

interface Line {
  text: string;
  cells: CellPosition[];
}

// Scans are viewport-local, never proportional to retained scrollback. The
// context on either side recovers blocks partly above/below the visible rows.
const CONTEXT_ROWS = 128;
const MAX_CHARACTERS = 32_768;
const MAX_BLOCKS = 32;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const GRAPH = /^\s*(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\s*;?\s*$/;
const SEQUENCE = /^\s*sequenceDiagram\s*$/;

/** Only explicit Mermaid statements extend an unfenced diagram into prose. */
function diagramStatement(text: string, sequence: boolean): boolean {
  const line = text.trim();
  if (line === '' || /^(?:%%|end\b)/.test(line)) return true;
  if (sequence)
    return (
      /^(?:participant|actor|create|destroy|activate|deactivate|note|loop|alt|else|opt|par|and|critical|option|break|rect|autonumber)\b/i.test(
        line,
      ) || /^\S+\s*(?:--?|<<-)[<>x)+-]*>/.test(line)
    );
  return (
    /^(?:subgraph|direction|style|classDef|class|linkStyle)\b/.test(line) ||
    /^[\w-]+\s*(?:\[|\(|\{|>|@\{|<*[-=.]+[->ox| ])/.test(line)
  );
}

/** Read the rendered buffer, so ANSI, overwritten output and replay need no parser. */
export function terminalRichBlocks(
  buffer: IBuffer,
  cols: number,
  viewportY: number,
  visibleRows: number,
): TerminalRichBlock[] {
  if (cols < 1 || visibleRows < 1) return [];
  // Reserve the viewport's share first: dense history on a very wide terminal
  // must not consume the entire character budget before we reach visible text.
  const contextRows = Math.min(
    CONTEXT_ROWS,
    Math.max(0, Math.floor((MAX_CHARACTERS / (cols + 1) - visibleRows) / 2)),
  );
  const first = Math.max(0, viewportY - contextRows);
  const last = Math.min(buffer.length, viewportY + visibleRows + contextRows);
  const lines: Line[] = [];
  let characters = 0;
  for (let row = first; row < last; row++) {
    const mapped = readRow(buffer, row, cols);
    if (!mapped) break;
    const end = buffer.getLine(row + 1)?.isWrapped
      ? mapped.text.length
      : mapped.text.trimEnd().length;
    characters += end + 1;
    if (characters > MAX_CHARACTERS) break;
    const previous = lines.at(-1);
    if (mapped.isWrapped && previous) {
      previous.text += mapped.text.slice(0, end);
      previous.cells.push(...mapped.cells.slice(0, end));
    } else {
      lines.push({ text: mapped.text.slice(0, end), cells: mapped.cells.slice(0, end) });
    }
  }

  const blocks: TerminalRichBlock[] = [];
  const add = (
    kind: TerminalRichBlock['kind'],
    source: string,
    display: boolean,
    cells: CellPosition[],
  ) => {
    const start = cells[0];
    const final = cells.at(-1);
    if (!start || !final || !source.trim() || blocks.length >= MAX_BLOCKS) return;
    if (final.row < viewportY || start.row >= viewportY + visibleRows) return;
    const width = buffer.getLine(final.row)?.getCell(final.col)?.getWidth() ?? 1;
    blocks.push({
      kind,
      source: source.trim(),
      display,
      start,
      end: { row: final.row, col: final.col + Math.max(1, width) - 1 },
    });
  };

  for (let index = 0; index < lines.length && blocks.length < MAX_BLOCKS; index++) {
    const line = lines[index]!;
    const fence = FENCE.exec(line.text);
    if (fence) {
      let end = index + 1;
      while (end < lines.length) {
        const closing = FENCE.exec(lines[end]!.text);
        if (
          closing &&
          !closing[2]!.trim() &&
          closing[1]![0] === fence[1]![0] &&
          closing[1]!.length >= fence[1]!.length
        )
          break;
        end++;
      }
      // Unfinished/ordinary code fences stay literal, including TeX examples.
      if (end === lines.length) break;
      const language = fence[2]!.trim().split(/\s+/)[0]!.toLowerCase();
      if (['mermaid', 'math', 'latex', 'tex'].includes(language)) {
        const body = lines
          .slice(index + 1, end)
          .map((part) => part.text)
          .join('\n');
        add(
          language === 'mermaid' ? 'mermaid' : 'math',
          body,
          true,
          lines.slice(index, end + 1).flatMap((part) => part.cells),
        );
      }
      index = end;
      continue;
    }

    // Agent Markdown renderers often remove code fences but retain Mermaid's
    // declaration and indentation (including blank lines between subgraphs).
    const sequence = SEQUENCE.test(line.text);
    if (GRAPH.test(line.text) || sequence) {
      let end = index + 1;
      while (end < lines.length && diagramStatement(lines[end]!.text, sequence)) end++;
      while (end > index + 1 && !lines[end - 1]!.text.trim()) end--;
      if (end > index + 1) {
        const parts = lines.slice(index, end);
        add(
          'mermaid',
          parts.map((part) => part.text).join('\n'),
          true,
          parts.flatMap((part) => part.cells),
        );
        index = end - 1;
        continue;
      }
    }

    const trimmed = line.text.trim();
    if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
      let source = trimmed;
      let end = index;
      let match = matchMathAt(source);
      while (!match && end + 1 < lines.length) {
        source += `\n${lines[++end]!.text.trim()}`;
        match = matchMathAt(source);
        if (/\n\s*\n/.test(source)) break;
      }
      // Cover complete display lines only. A trailing sentence still belongs
      // to xterm and can use the single-row expression path below.
      if (match?.display && match.length === source.length) {
        add(
          'math',
          match.tex,
          true,
          lines.slice(index, end + 1).flatMap((part) => part.cells),
        );
        index = end;
        continue;
      }
      if (trimmed === '$$' || trimmed === '\\[') continue;
    }

    for (let offset = 0; offset < line.text.length; offset++) {
      // Escaped dollars and Markdown code spans are literal terminal text.
      if (line.text[offset] === '`') {
        const delimiter = /^`+/.exec(line.text.slice(offset))![0];
        const end = line.text.indexOf(delimiter, offset + delimiter.length);
        if (end < 0) break;
        offset = end + delimiter.length - 1;
        continue;
      }
      const match = matchMathAt(line.text, offset);
      if (match) {
        const cells = line.cells.slice(offset, offset + match.length);
        // A multiline rectangle must own its whole logical line; otherwise
        // it would hide unrelated prose on the first/last wrapped row.
        if (
          cells[0]?.row === cells.at(-1)?.row ||
          line.text.trim() === line.text.slice(offset, offset + match.length)
        )
          add('math', match.tex, match.display, cells);
        offset += match.length - 1;
      } else if (line.text[offset] === '\\') offset++;
    }
  }
  return blocks;
}
