import { describe, expect, it } from 'vitest';
import { stripDeviceReplies } from '../../src/ws/device-replies.js';

describe('stripDeviceReplies', () => {
  it('strips every reply shape xterm 6 auto-emits', () => {
    // Verbatim captures from @xterm/xterm 6.0.0 answering the query family.
    expect(stripDeviceReplies('\x1b[37;143R')).toBe(''); // CPR (DSR 6)
    expect(stripDeviceReplies('\x1b[?37;143R')).toBe(''); // DECXCPR
    expect(stripDeviceReplies('\x1b[?37;143;1R')).toBe(''); // DECXCPR with page
    expect(stripDeviceReplies('\x1b[0n')).toBe(''); // DSR 5: ok
    expect(stripDeviceReplies('\x1b[3n')).toBe(''); // DSR 5: not ok
    expect(stripDeviceReplies('\x1b[?1;2c')).toBe(''); // DA1
    expect(stripDeviceReplies('\x1b[>0;276;0c')).toBe(''); // DA2
    expect(stripDeviceReplies('\x1bP1$r0m\x1b\\')).toBe(''); // DECRQSS report
    expect(stripDeviceReplies('\x1bP0$r\x1b\\')).toBe(''); // DECRQSS: unsupported
  });

  it('strips a burst of replayed reports wholesale', () => {
    // The literal junk from the bug report: many CPRs back to back.
    const burst = '\x1b[37;143R\x1b[34;32R\x1b[37;143R\x1b[35;34R\x1b[36;23R';
    expect(stripDeviceReplies(burst)).toBe('');
  });

  it('keeps surrounding input byte-exact', () => {
    expect(stripDeviceReplies('ls -la\x1b[12;40Rgit status\r')).toBe('ls -lagit status\r');
  });

  it('passes typed input, keys, and mouse reports untouched', () => {
    const inputs = [
      'plain typing\r',
      '\x1b[A\x1b[B\x1b[C\x1b[D', // arrows
      '\x1b[1;5C', // ctrl+→ (letter final: not a reply)
      '\x1b[H\x1b[F\x1b[3~\x1b[15~', // home/end/delete/F5 (tilde finals)
      '\x1bOP\x1bOR', // F1, plain F3 (SS3)
      '\x1b[<0;33;11M\x1b[<0;33;11m', // SGR mouse press/release
      '\x1b[200~pasted text\x1b[201~', // bracketed paste
      '\x1b', // a bare Escape keypress
      '\x03\x15', // ctrl-C, ctrl-U
    ];
    for (const input of inputs) expect(stripDeviceReplies(input)).toBe(input);
  });

  it('keeps modified F3, the one key that shares a reply shape', () => {
    expect(stripDeviceReplies('\x1b[1;2R')).toBe('\x1b[1;2R'); // shift+F3
    expect(stripDeviceReplies('\x1b[1;16R')).toBe('\x1b[1;16R'); // every-modifier F3
    // Beyond the xterm modifier range it is a genuine cursor report again.
    expect(stripDeviceReplies('\x1b[1;17R')).toBe('');
    expect(stripDeviceReplies('\x1b[1;143R')).toBe('');
  });

  it('leaves a DECRQSS QUERY alone — only the report shape is a reply', () => {
    expect(stripDeviceReplies('\x1bP$qm\x1b\\')).toBe('\x1bP$qm\x1b\\');
  });
});
