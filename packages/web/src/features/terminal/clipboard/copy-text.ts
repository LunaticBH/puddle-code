import type { Terminal } from '@xterm/xterm';
import { findBufferUrlCandidates, isHttpUri } from '../links/url-links';

/** Only a whole, standalone link becomes a URL; ordinary copied Markdown stays literal. */
export function normaliseCopiedLink(text: string): string {
  const value = text.trim();
  const autoLink = /^<([^<>]+)>$/.exec(value);
  if (autoLink && isHttpUri(autoLink[1]!)) return autoLink[1]!;
  const link = /^\[(?:\\.|[^\]\\])*\]\(\s*(?:<([^<>]+)>|([^\s]+))\s*\)$/.exec(value);
  if (!link) return text;
  const raw = link[1] ?? link[2]!;
  // In an unbracketed destination, a closing parenthesis belongs to the link
  // unless balanced within the URL. Reject multiple links or trailing syntax.
  if (link[2]) {
    let depth = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '\\') i++;
      else if (raw[i] === '(') depth++;
      else if (raw[i] === ')' && --depth < 0) return text;
    }
    if (depth !== 0) return text;
  }
  const uri = raw.replace(/\\([!-/:-@[-`{-~])/g, '$1');
  return isHttpUri(uri) ? uri : text;
}

/** Join a locally selected URL only when the complete selection matches a buffer link. */
export function terminalSelectionText(terminal: Terminal): string {
  const text = terminal.getSelection();
  const position = terminal.getSelectionPosition();
  if (position && /\r?\n/.test(text)) {
    const compact = text.trim().replace(/[\t ]*\r?\n[\t ]*/g, '');
    const link = findBufferUrlCandidates(
      terminal.buffer.active,
      position.start.y,
      terminal.cols,
    ).find(({ candidate }) => candidate.uri === compact);
    if (link) return link.candidate.uri;
  }
  return normaliseCopiedLink(text);
}
