import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { IBuffer, Terminal } from '@xterm/xterm';
import { currentTheme, onThemeChange } from '../../../lib/appearance/theme';
import { terminalRichBlocks, type TerminalRichBlock as RichBlock } from './rich-output-buffer';
import { TerminalRichBlock } from './TerminalRichBlock';

interface Projection {
  blocks: RichBlock[];
  viewportY: number;
  buffer: string;
  width: number;
  cellWidth: number;
  cellHeight: number;
  fontSize: number;
}

/** Cheap redraw validation of already-rendered regions, including their delimiters. */
function sourceSignature(buffer: IBuffer, blocks: RichBlock[]): string {
  return blocks
    .map(({ start, end }) => {
      const rows: string[] = [];
      for (let row = start.row; row <= end.row; row++)
        rows.push(buffer.getLine(row)?.translateToString(true) ?? '');
      return rows.join('\n');
    })
    .join('\n\0');
}

/** Render complete visible blocks. No polling or work for parked terminals. */
export function TerminalRichOutput({ terminal }: { terminal: Terminal }) {
  const [projection, setProjection] = useState<Projection | null>(null);
  const [obscured, setObscured] = useState(false);
  const theme = useSyncExternalStore(onThemeChange, currentTheme, currentTheme);
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');

  useEffect(() => {
    if (!screen) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let pending = true;
    let previous:
      | { blocks: RichBlock[]; signature: string; buffer: IBuffer; viewportY: number; cols: number }
      | undefined;
    const refresh = () => {
      frame = 0;
      const buffer = terminal.buffer.active;
      const blocks = terminalRichBlocks(buffer, terminal.cols, buffer.viewportY, terminal.rows);
      previous = {
        blocks,
        signature: sourceSignature(buffer, blocks),
        buffer,
        viewportY: buffer.viewportY,
        cols: terminal.cols,
      };
      setProjection({
        blocks,
        viewportY: buffer.viewportY,
        buffer: buffer.type,
        width: screen.clientWidth,
        cellWidth: screen.clientWidth / terminal.cols,
        cellHeight: screen.clientHeight / terminal.rows,
        fontSize: terminal.options.fontSize ?? 14,
      });
      pending = false;
      setObscured(terminal.hasSelection());
    };
    const schedule = (delay: number, retain = false) => {
      // Do not leave an old diagram covering a rewritten prompt while waiting
      // for a streamed response or a synchronised TUI redraw to settle.
      if (!retain) {
        setObscured(true);
        pending = true;
      }
      // Continuous TUI spinners must neither starve newly completed blocks nor
      // hide existing diagrams whose actual source cells are unchanged.
      if (delay > 0 && (timer !== undefined || frame !== 0)) return;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      timer = setTimeout(() => {
        timer = undefined;
        frame = requestAnimationFrame(refresh);
      }, delay);
    };
    const subscriptions = [
      terminal.onWriteParsed(() => {
        const buffer = terminal.buffer.active;
        const retain =
          !!previous &&
          previous.buffer === buffer &&
          previous.cols === terminal.cols &&
          previous.viewportY === buffer.viewportY &&
          previous.signature === sourceSignature(buffer, previous.blocks);
        schedule(120, retain);
      }),
      terminal.onScroll(() => schedule(0)),
      terminal.onResize(() => schedule(0)),
      terminal.buffer.onBufferChange(() => schedule(0)),
      terminal.onSelectionChange(() => setObscured(pending || terminal.hasSelection())),
    ];
    const observer = new ResizeObserver(() => schedule(0));
    observer.observe(screen);
    schedule(0);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [terminal, screen]);

  if (!screen || !projection) return null;
  const { cellWidth, cellHeight, viewportY, width } = projection;
  return createPortal(
    <div
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
      style={{ visibility: obscured ? 'hidden' : undefined }}
    >
      {projection.blocks.map((block) => {
        const multipleRows = block.start.row !== block.end.row;
        const left = multipleRows ? 0 : block.start.col * cellWidth;
        return (
          <TerminalRichBlock
            key={`${projection.buffer}:${block.start.row}:${block.start.col}:${block.source}`}
            block={block}
            theme={theme}
            fontSize={projection.fontSize}
            box={{
              left,
              top: (block.start.row - viewportY) * cellHeight,
              width: multipleRows ? width : (block.end.col - block.start.col + 1) * cellWidth,
              height: (block.end.row - block.start.row + 1) * cellHeight,
            }}
          />
        );
      })}
    </div>,
    screen,
  );
}
