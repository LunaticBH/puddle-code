import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  terminalClipboard,
  writeTerminalClipboard,
} from '../../src/features/terminal/clipboard/clipboard';
import {
  registerFileLinks,
  type FileLinkTarget,
} from '../../src/features/terminal/links/file-links';
import { registerUrlLinks } from '../../src/features/terminal/links/url-links';
import { terminalSelectionText } from '../../src/features/terminal/clipboard/copy-text';

const terminal = new Terminal({
  cols: 22,
  rows: 12,
  allowProposedApi: true,
  macOptionClickForcesSelection: true,
});
const container = document.getElementById('terminal')!;
terminal.open(container);
let replaying = false;
let selectedByApplication = false;
let applicationText = 'remote selection';
const input: string[] = [];
const opened: FileLinkTarget[] = [];
const urls: string[] = [];
const errors: string[] = [];
const send = (data: string) => {
  input.push(data);
  if (data.startsWith('\x1b[<32;')) selectedByApplication = true;
  // A deterministic mouse-aware application: selection alone sends no OSC 52;
  // an explicit copy key produces a delayed reply, as over an SSH connection.
  if (selectedByApplication && ['\x03', '\x1b[99;9u', '\x1b[99;6u'].includes(data)) {
    setTimeout(() => terminal.write(`\x1b]52;c;${btoa(applicationText)}\x07`), 60);
  }
};
const clipboard = terminalClipboard({
  isMac: true,
  selection: () => terminalSelectionText(terminal),
  mouseTracking: () => terminal.modes.mouseTrackingMode !== 'none',
  available: () => !replaying,
  writeInput: send,
  writeClipboard: (text) => writeTerminalClipboard(text, () => errors.push('Copy failed')),
});
terminal.parser.registerOscHandler(52, clipboard.osc);
terminal.onData((data) => {
  clipboard.input(data);
  send(data);
});
terminal.attachCustomKeyEventHandler((event) => {
  if (!clipboard.key(event)) return true;
  event.preventDefault();
  return false;
});
container.addEventListener('copy', clipboard.copy, true);
container.addEventListener('focusout', clipboard.reset);
container.addEventListener('mousedown', clipboard.reset, true);
registerUrlLinks(terminal, (uri) => urls.push(uri));
registerFileLinks(terminal, 'session', (target) => opened.push(target));
Object.assign(window, {
  terminalInteractions: {
    input: () => [...input],
    opened: () => [...opened],
    urls: () => [...urls],
    resize: (cols: number) => terminal.resize(cols, terminal.rows),
    select: (col: number, row: number, length: number) => terminal.select(col, row, length),
    errors: () => [...errors],
    selection: () => terminal.getSelection(),
    applicationText: (text: string) => {
      applicationText = text;
      selectedByApplication = false;
    },
    focus: () => terminal.focus(),
    write: async (data: string, replay = false) => {
      if (replay) clipboard.reset();
      replaying = replay;
      await new Promise<void>((resolve) => terminal.write(data, resolve));
      replaying = false;
    },
    cell: (column: number, row: number) => {
      const rect = terminal.element!.querySelector('.xterm-screen')!.getBoundingClientRect();
      return {
        x: rect.x + ((column + 0.5) * rect.width) / terminal.cols,
        y: rect.y + ((row + 0.5) * rect.height) / terminal.rows,
      };
    },
  },
});
