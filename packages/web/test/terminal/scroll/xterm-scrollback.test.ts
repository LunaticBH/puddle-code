import { Terminal as XTerm } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { preserveXtermScrollUp } from '../../../src/features/terminal/scroll/xterm-scrollback';

function write(terminal: XTerm, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

describe('xterm scrollback preservation', () => {
  it('keeps lines scrolled out of a top-anchored TUI region', async () => {
    const terminal = new XTerm({
      allowProposedApi: true,
      cols: 20,
      rows: 10,
      scrollback: 100,
    });
    preserveXtermScrollUp(terminal);

    await write(terminal, '0\r\n1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8\r\n9\u001b[1;4r\u001b[2Sm');

    const buffer = terminal.buffer.active;
    expect(
      Array.from(
        { length: buffer.length },
        (_, row) => buffer.getLine(row)?.translateToString(true) ?? '',
      ),
    ).toEqual(['0', '1', 'm', '3', '', '', '4', '5', '6', '7', '8', '9']);
    terminal.dispose();
  });

  it("leaves non-top scroll regions on xterm's native path", async () => {
    const terminal = new XTerm({
      allowProposedApi: true,
      cols: 20,
      rows: 10,
      scrollback: 100,
    });
    preserveXtermScrollUp(terminal);
    preserveXtermScrollUp(terminal);

    await write(terminal, '0\r\n1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8\r\n9\u001b[2;4r\u001b[2Sm');

    const buffer = terminal.buffer.active;
    expect(buffer.baseY).toBe(0);
    expect(buffer.getLine(0)?.translateToString(true)).toBe('m');
    expect(buffer.getLine(1)?.translateToString(true)).toBe('3');
    terminal.dispose();
  });
});
