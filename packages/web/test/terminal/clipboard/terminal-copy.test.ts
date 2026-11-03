import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  terminalClipboard,
  writeTerminalClipboard,
} from '../../../src/features/terminal/clipboard/clipboard';
import type { CopyKeyEvent } from '../../../src/features/terminal/clipboard/copy-shortcut';

const key = (overrides: Partial<CopyKeyEvent> = {}): CopyKeyEvent => ({
  type: 'keydown',
  key: 'c',
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});
const osc = (text: string) => `c;${Buffer.from(text).toString('base64')}`;
function setup(isMac = true) {
  const options = {
    isMac,
    selection: vi.fn(() => ''),
    mouseTracking: vi.fn(() => true),
    available: vi.fn(() => true),
    writeInput: vi.fn(),
    writeClipboard: vi.fn((value: string | Promise<string>) => {
      if (typeof value !== 'string') void value.catch(() => {});
    }),
  };
  return { options, clipboard: terminalClipboard(options) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('terminal copy', () => {
  const uri = 'http://100.122.14.32:8767/r/run_name_QRD/S02-yam/motion-profiles.png';
  const markdown = `[${uri.replaceAll('_', '\\_')}](<${uri}>)`;

  it.each(['local', 'stashed', 'delayed', 'menu'])(
    'copies a link as a plain URL via %s',
    async (source) => {
      const { options, clipboard } = setup();
      if (source === 'local' || source === 'menu') options.selection.mockReturnValue(markdown);
      if (source === 'stashed') clipboard.osc(osc(markdown));
      if (source === 'menu') {
        const event = {
          clipboardData: { setData: vi.fn() },
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        };
        clipboard.copy(event as unknown as ClipboardEvent);
        expect(event.clipboardData.setData).toHaveBeenCalledWith('text/plain', uri);
      } else {
        clipboard.key(key());
        if (source === 'delayed') clipboard.osc(osc(markdown));
        expect(await options.writeClipboard.mock.calls[0]![0]).toBe(uri);
      }
    },
  );

  it('keeps local scrollback copyable when the host is unavailable', () => {
    const { options, clipboard } = setup();
    options.available.mockReturnValue(false);
    options.selection.mockReturnValue('local history');
    expect(clipboard.key(key())).toBe(true);
    expect(options.writeClipboard).toHaveBeenCalledExactlyOnceWith('local history');
    expect(options.writeInput).not.toHaveBeenCalled();
  });
  it.each([key(), key({ metaKey: false, ctrlKey: true })])(
    'copies local selection before OSC text without sending input (%j)',
    (event) => {
      const { options, clipboard } = setup();
      clipboard.osc(osc('application text'));
      options.selection.mockReturnValue('local selection');
      expect(clipboard.key(event)).toBe(true);
      expect(options.writeClipboard).toHaveBeenCalledExactlyOnceWith('local selection');
      expect(options.writeInput).not.toHaveBeenCalled();
    },
  );

  it('stashes unsolicited OSC writes until an explicit copy, preserving Unicode', () => {
    const { options, clipboard } = setup();
    clipboard.osc(osc('日本語 🌊'));
    expect(options.writeClipboard).not.toHaveBeenCalled();
    clipboard.input('\x1b[<64;4;5M');
    clipboard.key(key());
    expect(options.writeClipboard).toHaveBeenCalledExactlyOnceWith('日本語 🌊');
  });

  it.each([
    [true, key(), '\x1b[99;9u'],
    [true, key({ metaKey: false, ctrlKey: true }), '\x03'],
    [false, key({ metaKey: false, ctrlKey: true, shiftKey: true }), '\x1b[99;6u'],
  ] as const)(
    'copies the first delayed application reply (Mac: %s, %j)',
    async (isMac, event, encoded) => {
      const { options, clipboard } = setup(isMac);
      expect(clipboard.key(event)).toBe(true);
      expect(options.writeInput).toHaveBeenCalledExactlyOnceWith(encoded);
      const response = options.writeClipboard.mock.calls[0]![0];
      expect(response).toBeInstanceOf(Promise);
      await vi.advanceTimersByTimeAsync(150);
      clipboard.osc(osc('selected by the application'));
      await expect(response).resolves.toBe('selected by the application');
      clipboard.osc(osc('later unsolicited write'));
      expect(options.writeClipboard).toHaveBeenCalledTimes(1);
    },
  );

  it('leaves Ctrl-C alone in an unselected shell and ignores keyup/keypress', () => {
    const { options, clipboard } = setup();
    options.mouseTracking.mockReturnValue(false);
    expect(clipboard.key(key({ metaKey: false, ctrlKey: true }))).toBe(false);
    expect(clipboard.key(key())).toBe(false);
    options.selection.mockReturnValue('selected');
    expect(clipboard.key(key({ type: 'keyup' }))).toBe(false);
    expect(clipboard.key(key({ type: 'keypress' }))).toBe(false);
    expect(options.writeClipboard).not.toHaveBeenCalled();
  });

  it.each(['typing', 'reset', 'timeout', 'unavailable', 'malformed', 'clear'])(
    'cancels pending copy on %s',
    async (cause) => {
      const { options, clipboard } = setup();
      clipboard.key(key());
      const response = options.writeClipboard.mock.calls[0]![0];
      const cancelled = expect(response).rejects.toMatchObject({ name: 'AbortError' });
      if (cause === 'typing') clipboard.input('x');
      if (cause === 'reset') clipboard.reset();
      if (cause === 'timeout') await vi.advanceTimersByTimeAsync(2000);
      if (cause === 'unavailable') {
        options.available.mockReturnValue(false);
        clipboard.osc(osc('historical'));
      }
      if (cause === 'malformed') clipboard.osc('c;%%%');
      if (cause === 'clear') clipboard.osc('c;');
      await cancelled;
      clipboard.osc(osc('late response'));
      expect(options.writeClipboard).toHaveBeenCalledTimes(1);
    },
  );

  it('never answers clipboard queries or commits replayed text', () => {
    const { options, clipboard } = setup();
    clipboard.osc('c;?');
    options.available.mockReturnValue(false);
    clipboard.osc(osc('old text'));
    expect(options.writeInput).not.toHaveBeenCalled();
    expect(options.writeClipboard).not.toHaveBeenCalled();
    options.available.mockReturnValue(true);
    options.mouseTracking.mockReturnValue(false);
    clipboard.key(key());
    expect(options.writeClipboard).not.toHaveBeenCalled();
  });

  it('handles the desktop Copy event with and without local text', async () => {
    const { options, clipboard } = setup();
    const event = {
      clipboardData: { setData: vi.fn() },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    options.selection.mockReturnValue('local');
    clipboard.copy(event as unknown as ClipboardEvent);
    expect(event.clipboardData.setData).toHaveBeenCalledExactlyOnceWith('text/plain', 'local');
    options.selection.mockReturnValue('');
    clipboard.copy(event as unknown as ClipboardEvent);
    expect(options.writeInput).toHaveBeenCalledExactlyOnceWith('\x1b[99;9u');
    clipboard.osc(osc('native'));
    await expect(options.writeClipboard.mock.calls[0]![0]).resolves.toBe('native');
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
  });
});

it('reserves a clipboard write during the gesture, before the text arrives', async () => {
  let deliver!: (text: string) => void;
  const response = new Promise<string>((resolve) => {
    deliver = resolve;
  });
  const items: Array<Record<string, Promise<Blob>>> = [];
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(value: Record<string, Promise<Blob>>) {
        items.push(value);
      }
    },
  );
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { write } });
  const failed = vi.fn();
  writeTerminalClipboard(response, failed);
  expect(write).toHaveBeenCalledTimes(1);
  deliver('copied after a round trip');
  expect(await (await items[0]!['text/plain']!).text()).toBe('copied after a round trip');
  expect(failed).not.toHaveBeenCalled();
});

it('reports clipboard denial after text arrives, without an unhandled rejection', async () => {
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
  });
  const failed = vi.fn();
  writeTerminalClipboard('selection', failed);
  await vi.runAllTimersAsync();
  expect(failed).toHaveBeenCalledTimes(1);
});
