import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { attachIosTerminalInput } from '../../src/features/terminal/input/ios-input';
import { attachTerminalTouchScroll } from '../../src/features/terminal/scroll/touch-scroll';
import { TerminalKeys } from '../../src/features/mobile/TerminalKeys';
import {
  consumeTerminalModifiers,
  registerTerminalInput,
} from '../../src/features/terminal/input/input';
import { installBrowserTransport } from '../../src/lib/transport/browser-transport';
import { PhoneDiff } from '../../src/features/mobile/PhoneDiff';
import '../../src/features/remote/remote.css';
import '../../src/styles/tokens.css';

const terminal = new Terminal({ cols: 32, rows: 8 });
terminal.open(document.getElementById('terminal')!);
let active = true;
let input: string[] = [];
attachIosTerminalInput(terminal, () => active);
terminal.onData((data) => input.push(consumeTerminalModifiers('fixture', 'agent', data)));
installBrowserTransport({
  scope: 'editing-fixture',
  input: async (_session, _term, data) => {
    input.push(data);
  },
  request: async () => {
    throw new Error('Unexpected request');
  },
  socket: () => {
    throw new Error('Unexpected socket');
  },
});
registerTerminalInput(
  'fixture',
  'agent',
  (text) => text,
  () => terminal.focus(),
  () => terminal.modes.applicationCursorKeysMode,
);
attachTerminalTouchScroll(
  terminal,
  () => active,
  () => {},
  () => {},
);
createRoot(document.getElementById('controls')!).render(
  <>
    <style>{'.phone-keys { padding-inline: 2rem; }'}</style>
    <TerminalKeys
      session="fixture"
      term="agent"
      connected
      composing={false}
      toggleComposer={() => {}}
    />
  </>,
);
createRoot(document.getElementById('diff')!).render(
  <PhoneDiff
    before={'heading\nold text\ntail\n'}
    after={'heading\nnew text\n<script>window.executed = true</script>\ntail\n'}
  />,
);
Object.assign(window, {
  editing: {
    input: () => input.join(''),
    clear: () => {
      input = [];
    },
    focus: () => terminal.focus(),
    active: (value: boolean) => {
      active = value;
    },
    write: (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve)),
    cell: (column: number, row: number) => {
      const rect = terminal.element!.querySelector('.xterm-screen')!.getBoundingClientRect();
      return {
        x: rect.x + ((column + 0.1) * rect.width) / terminal.cols,
        y: rect.y + ((row + 0.5) * rect.height) / terminal.rows,
      };
    },
  },
});
