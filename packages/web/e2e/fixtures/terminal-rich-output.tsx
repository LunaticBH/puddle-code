import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import '../../src/styles/app.css';
import { TerminalRichOutput } from '../../src/features/terminal/rich-output/TerminalRichOutput';
import {
  applyTheme,
  cssTokenReader,
  onThemeChange,
  xtermThemeFromCss,
} from '../../src/lib/appearance/theme';

declare global {
  interface Window {
    richTerminal: {
      write(text: string): Promise<void>;
      reset(): void;
      resize(cols: number): void;
      scroll(row: number): void;
      select(col: number, row: number, length: number): void;
      clearSelection(): void;
      selection(): string;
      text(): string;
      input: string[];
      theme: typeof applyTheme;
    };
  }
}

function Fixture() {
  const ref = useRef<HTMLDivElement>(null);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  useEffect(() => {
    const xterm = new Terminal({
      cols: 100,
      rows: 32,
      fontSize: 15,
      fontFamily: cssTokenReader()('--font-mono'),
      theme: xtermThemeFromCss(),
      scrollback: 2000,
    });
    xterm.open(ref.current!);
    setTerminal(xterm);
    const input: string[] = [];
    const subscription = xterm.onData((text) => input.push(text));
    const unsubscribe = onThemeChange(() => {
      xterm.options.theme = xtermThemeFromCss();
    });
    window.richTerminal = {
      write: (text) => new Promise((resolve) => xterm.write(text, resolve)),
      reset: () => xterm.reset(),
      resize: (cols) => xterm.resize(cols, 32),
      scroll: (row) => xterm.scrollToLine(row),
      select: (col, row, length) => xterm.select(col, row, length),
      clearSelection: () => xterm.clearSelection(),
      selection: () => xterm.getSelection(),
      text: () =>
        Array.from({ length: xterm.buffer.active.length }, (_, row) =>
          xterm.buffer.active.getLine(row)!.translateToString(true),
        ).join('\n'),
      input,
      theme: applyTheme,
    };
    return () => {
      subscription.dispose();
      unsubscribe();
      xterm.dispose();
    };
  }, []);
  return (
    <div className="group/terminal relative h-screen bg-ground p-4">
      <div ref={ref} />
      {terminal && <TerminalRichOutput terminal={terminal} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
