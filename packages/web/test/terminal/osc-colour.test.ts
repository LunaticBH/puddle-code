import { Terminal } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';
import {
  dynamicColourReport,
  hexToXtermRgb,
  registerDynamicColourQueries,
} from '../../src/features/terminal/osc-colour';

describe('hexToXtermRgb', () => {
  it('doubles each channel to the 16-bit XTerm form', () => {
    expect(hexToXtermRgb('#000a14')).toBe('rgb:0000/0a0a/1414');
    expect(hexToXtermRgb('#ffffff')).toBe('rgb:ffff/ffff/ffff');
  });
  it('accepts a colour without the leading hash', () => {
    expect(hexToXtermRgb('7dadff')).toBe('rgb:7d7d/adad/ffff');
  });
  it('ignores an alpha channel', () => {
    expect(hexToXtermRgb('#7dadff4d')).toBe('rgb:7d7d/adad/ffff');
  });
  it('lower-cases the output', () => {
    expect(hexToXtermRgb('#EAF1FB')).toBe('rgb:eaea/f1f1/fbfb');
  });
  it('rejects shorthand and non-hex input', () => {
    expect(hexToXtermRgb('#fff')).toBeNull();
    expect(hexToXtermRgb('rgb(0,0,0)')).toBeNull();
    expect(hexToXtermRgb('')).toBeNull();
  });
});

describe('dynamicColourReport', () => {
  it('wraps the background colour in an OSC 11 report with an ST terminator', () => {
    expect(dynamicColourReport(11, '#000a14')).toBe('\x1b]11;rgb:0000/0a0a/1414\x1b\\');
  });
  it('uses the query code for the foreground', () => {
    expect(dynamicColourReport(10, '#eaf1fb')).toBe('\x1b]10;rgb:eaea/f1f1/fbfb\x1b\\');
  });
  it('returns null when the colour cannot be parsed, so nothing is sent', () => {
    expect(dynamicColourReport(11, 'transparent')).toBeNull();
  });
});

describe('terminal colour-query ownership', () => {
  it.each([true, false])('consumes queries with daemonAnswers=%s', async (daemonAnswers) => {
    const terminal = new Terminal({ allowProposedApi: true });
    // A lower-priority handler stands in for xterm's browser-only responder.
    // Exercise the real parser, including sequences split across writes.
    const fallback = vi.fn(() => true);
    terminal.parser.registerOscHandler(10, fallback);
    terminal.parser.registerOscHandler(11, fallback);
    const reply = vi.fn();
    let replaying = false;
    let colour = '#000a14';
    const handlers = registerDynamicColourQueries(terminal, {
      daemonAnswers,
      isReplaying: () => replaying,
      readColour: () => colour,
      reply,
    });
    const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
    try {
      await write('\x1b]10;');
      await write('?\x07\x1b]11;?\x1b\\');
      expect(fallback).not.toHaveBeenCalled();
      expect(reply.mock.calls).toEqual(
        daemonAnswers
          ? []
          : [['\x1b]10;rgb:0000/0a0a/1414\x1b\\'], ['\x1b]11;rgb:0000/0a0a/1414\x1b\\']],
      );

      reply.mockClear();
      colour = '#ffffff';
      await write('\x1b]11;?\x07');
      expect(reply.mock.calls).toEqual(daemonAnswers ? [] : [['\x1b]11;rgb:ffff/ffff/ffff\x1b\\']]);

      reply.mockClear();
      replaying = true;
      await write('\x1b]10;?\x07\x1b]11;?\x1b\\');
      expect(reply).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();

      await write('\x1b]11;rgb:00/00/00\x07');
      expect(fallback).toHaveBeenCalledExactlyOnceWith('rgb:00/00/00');

      handlers.dispose();
      fallback.mockClear();
      await write('\x1b]10;?\x07\x1b]11;?\x07');
      expect(fallback).toHaveBeenCalledTimes(2);
    } finally {
      terminal.dispose();
    }
  });
});
