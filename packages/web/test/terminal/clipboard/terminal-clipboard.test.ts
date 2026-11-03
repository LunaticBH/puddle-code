import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  installBrowserTransport,
  type BrowserTransport,
} from '../../../src/lib/transport/browser-transport';
import { wsManager } from '../../../src/lib/transport/ws';
import {
  pasteTerminalClipboard,
  registerTerminalInput,
  toggleTerminalModifier,
} from '../../../src/features/terminal/input/input';

vi.mock('../../../src/lib/transport/ws', () => ({
  wsManager: { isConnected: vi.fn(() => true), write: vi.fn() },
}));

const readText = vi.fn<() => Promise<string>>();
const focus = vi.fn();
let unregister = () => {};
const session = 'terminal';
const remote = (): BrowserTransport => ({
  scope: crypto.randomUUID(),
  generation: crypto.randomUUID(),
  input: vi.fn().mockResolvedValue(undefined),
  request: vi.fn(),
  socket: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(wsManager.isConnected).mockReturnValue(true);
  vi.stubGlobal('navigator', { clipboard: { readText } });
});
afterEach(() => {
  unregister();
  installBrowserTransport(null);
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'pastes through the terminal encoder without adding Enter (remote: %s)',
  async (isRemote) => {
    const transport = isRemote ? remote() : null;
    installBrowserTransport(transport);
    const text = 'Hello 日本語 🌊\nsecond line';
    const encoded = '\x1b[200~Hello 日本語 🌊\rsecond line\x1b[201~';
    const encode = vi.fn(() => encoded);
    unregister = registerTerminalInput(session, 'agent', encode, focus);
    toggleTerminalModifier(session, 'agent', 1);
    readText.mockResolvedValueOnce(text);
    await pasteTerminalClipboard(session, 'agent', () => true);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(encode).toHaveBeenCalledExactlyOnceWith(text);
    expect(transport?.input ?? wsManager.write).toHaveBeenCalledExactlyOnceWith(
      session,
      'agent',
      encoded,
    );
    if (transport) expect(wsManager.write).not.toHaveBeenCalled();
  },
);

it.each(['host', 'reconnect', 'terminal', 'hidden', 'disconnected'])(
  'does not paste if %s changes while clipboard permission is pending',
  async (change) => {
    const transport = remote();
    installBrowserTransport(transport);
    const encode = vi.fn((text: string) => text);
    unregister = registerTerminalInput(session, 'agent', encode);
    let active = true;
    let finish!: (text: string) => void;
    readText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = pasteTerminalClipboard(session, 'agent', () => active);
    if (change === 'host') installBrowserTransport(remote());
    if (change === 'reconnect') Object.assign(transport, { generation: crypto.randomUUID() });
    if (change === 'terminal') unregister();
    if (change === 'hidden') active = false;
    if (change === 'disconnected') vi.mocked(wsManager.isConnected).mockReturnValue(false);
    finish('Do not send');
    await expect(pending).rejects.toThrow('nothing was pasted');
    expect(encode).not.toHaveBeenCalled();
    expect(transport.input).not.toHaveBeenCalled();
    expect(wsManager.write).not.toHaveBeenCalled();
  },
);

it('reports denied clipboard access and sends nothing for an empty clipboard', async () => {
  const encode = vi.fn((text: string) => text);
  unregister = registerTerminalInput(session, 'agent', encode);
  readText.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
  await expect(pasteTerminalClipboard(session, 'agent', () => true)).rejects.toThrow(
    'clipboard access',
  );
  readText.mockResolvedValueOnce('');
  await pasteTerminalClipboard(session, 'agent', () => true);
  expect(encode).not.toHaveBeenCalled();
  expect(wsManager.write).not.toHaveBeenCalled();
});

it('does not retry an uncertain remote write', async () => {
  const transport = remote();
  installBrowserTransport(transport);
  unregister = registerTerminalInput(session, 'agent', (text) => text);
  readText.mockResolvedValueOnce('once');
  vi.mocked(transport.input).mockRejectedValueOnce(new Error('Connection interrupted'));
  await expect(pasteTerminalClipboard(session, 'agent', () => true)).rejects.toThrow(
    'Connection interrupted',
  );
  expect(transport.input).toHaveBeenCalledExactlyOnceWith(session, 'agent', 'once');
  expect(wsManager.write).not.toHaveBeenCalled();
});
