/**
 * Answers to the terminal "dynamic colours" queries (OSC 10 foreground, OSC 11
 * background). A program running in the PTY sends `ESC ] 11 ; ? ST` to learn the
 * terminal's background colour; agents whose theme is set to auto/system (e.g.
 * Claude Code) use the reply's luminance to decide whether to render light or
 * dark. xterm 6 answers these queries itself, so handlers must consume them
 * when the daemon owns the reply, as well as during historical replay.
 *
 * The report encodes the colour as `rgb:RRRR/GGGG/BBBB` — 16 bits per channel,
 * the canonical XTerm form — by doubling each 8-bit hex pair (`0a` → `0a0a`).
 */

import type { Terminal } from '@xterm/xterm';

export type DynamicColourCode = 10 | 11;

/**
 * Converts `#RRGGBB` (or `#RRGGBBAA`, alpha ignored) to the `rgb:RRRR/GGGG/BBBB`
 * form an OSC 10/11 report expects. Returns null for anything that is not a
 * 6/8-digit hex colour — callers should feed it a resolved token, not shorthand
 * (cssTokenReader already expands `#fff` → `#ffffff`).
 */
export function hexToXtermRgb(hex: string): string | null {
  const match = /^#?([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(hex.trim());
  if (!match) return null;
  const rgb = match[1]!.toLowerCase();
  const pair = (i: number) => rgb.slice(i, i + 2).repeat(2);
  return `rgb:${pair(0)}/${pair(2)}/${pair(4)}`;
}

/**
 * Builds the full OSC report a terminal writes back to answer a colour query,
 * e.g. `ESC ] 11 ; rgb:0000/0a0a/1414 ST`. The ECMA-48 string terminator (ST,
 * `ESC \`) is used; readers that query these colours accept it. Returns null
 * when the colour cannot be parsed, so the caller sends nothing.
 */
export function dynamicColourReport(code: DynamicColourCode, hex: string): string | null {
  const rgb = hexToXtermRgb(hex);
  return rgb ? `\x1b]${code};${rgb}\x1b\\` : null;
}

/** Keep exactly one colour-query responder, even with multiple viewers. */
export function registerDynamicColourQueries(
  terminal: Pick<Terminal, 'parser'>,
  options: {
    daemonAnswers: boolean;
    isReplaying: () => boolean;
    readColour: (code: DynamicColourCode) => string;
    reply: (report: string) => void;
  },
): { dispose: () => void } {
  const handlers = ([10, 11] as const).map((code) =>
    terminal.parser.registerOscHandler(code, (data) => {
      if (data !== '?') return false; // preserve xterm's colour-setting behaviour
      if (!options.daemonAnswers && !options.isReplaying()) {
        const report = dynamicColourReport(code, options.readColour(code));
        if (report) options.reply(report);
      }
      // Returning false (or omitting the handler) lets xterm send another reply.
      return true;
    }),
  );
  return { dispose: () => handlers.forEach((handler) => handler.dispose()) };
}
