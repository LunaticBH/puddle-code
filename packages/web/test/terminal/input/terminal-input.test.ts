import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installBrowserTransport,
  type BrowserTransport,
} from '../../../src/lib/transport/browser-transport';
import { wsManager } from '../../../src/lib/transport/ws';
import {
  consumeTerminalModifiers,
  registerTerminalInput,
  sendTerminalInput,
  toggleTerminalModifier,
} from '../../../src/features/terminal/input/input';
import { TOUCH_MODIFIERS } from '../../../src/features/terminal/input/touch-modifiers';

vi.mock('../../../src/lib/transport/ws', () => ({
  wsManager: { isConnected: () => true, write: vi.fn() },
}));
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  installBrowserTransport(null);
  vi.clearAllMocks();
});
function register(session = 'session', applicationCursorKeys = () => false) {
  const dispose = registerTerminalInput(
    session,
    'agent',
    (text) => text,
    undefined,
    applicationCursorKeys,
  );
  disposers.push(dispose);
  return dispose;
}

describe('terminal modifier lifetime and delivery', () => {
  it.each([false, true])(
    'sends Shift-Left once over the active transport (remote: %s)',
    async (remote) => {
      const input = vi.fn(async () => {});
      if (remote) installBrowserTransport({ scope: 'host', input } as unknown as BrowserTransport);
      register();
      toggleTerminalModifier('session', 'agent', TOUCH_MODIFIERS.shift);
      await sendTerminalInput('session', 'agent', '\x1b[D');
      await sendTerminalInput('session', 'agent', '\x1b[D');
      expect(remote ? input : wsManager.write).toHaveBeenNthCalledWith(
        1,
        'session',
        'agent',
        '\x1b[1;2D',
      );
      expect(remote ? input : wsManager.write).toHaveBeenNthCalledWith(
        2,
        'session',
        'agent',
        '\x1b[D',
      );
    },
  );
  it('keeps modifiers pending across replies, mouse reports and bracketed paste', () => {
    register();
    toggleTerminalModifier('session', 'agent', TOUCH_MODIFIERS.shift);
    for (const data of ['\x1b[1;2R', '\x1b[?1;2c', '\x1b[<0;1;1M', '\x1b[200~text\x1b[201~']) {
      expect(consumeTerminalModifiers('session', 'agent', data)).toBe(data);
    }
    expect(consumeTerminalModifiers('session', 'agent', '\x1bOD')).toBe('\x1b[1;2D');
    expect(consumeTerminalModifiers('session', 'agent', '\x1bOD')).toBe('\x1bOD');
  });
  it('consumes Opt-Escape and permits toggling a modifier off', () => {
    register();
    toggleTerminalModifier('session', 'agent', TOUCH_MODIFIERS.alt);
    expect(consumeTerminalModifiers('session', 'agent', '\x1b')).toBe('\x1b\x1b');
    expect(consumeTerminalModifiers('session', 'agent', 'x')).toBe('x');
    toggleTerminalModifier('session', 'agent', TOUCH_MODIFIERS.shift);
    toggleTerminalModifier('session', 'agent', TOUCH_MODIFIERS.shift);
    expect(consumeTerminalModifiers('session', 'agent', 'x')).toBe('x');
  });
  it('uses the terminal’s current application-cursor mode for strip arrows', async () => {
    let application = false;
    register('session', () => application);
    await sendTerminalInput('session', 'agent', '\x1b[D');
    application = true;
    await sendTerminalInput('session', 'agent', '\x1b[D');
    toggleTerminalModifier('session', 'agent', TOUCH_MODIFIERS.ctrl);
    await sendTerminalInput('session', 'agent', '\x1b[D');
    expect(vi.mocked(wsManager.write).mock.calls.map((call) => call[2])).toEqual([
      '\x1b[D',
      '\x1bOD',
      '\x1b[1;5D',
    ]);
  });
  it('keeps modifiers per terminal and discards them on detachment', () => {
    const dispose = register();
    register('other');
    toggleTerminalModifier('session', 'agent', TOUCH_MODIFIERS.shift);
    expect(consumeTerminalModifiers('other', 'agent', 'x')).toBe('x');
    dispose();
    register();
    expect(consumeTerminalModifiers('session', 'agent', 'x')).toBe('x');
  });
});
