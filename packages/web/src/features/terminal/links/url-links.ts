import type { IBuffer, IDisposable, Terminal } from '@xterm/xterm';
import { findBufferLinkCandidates, type MappedRow } from './link-buffer';

export interface UrlCandidate {
  uri: string;
  start: number;
  end: number;
}

/** Validate without reserialising: escapes, query strings and fragments stay intact. */
export function isHttpUri(text: string): boolean {
  if (!/^https?:\/\//i.test(text) || /[\s<>"`\\\p{Cc}]/u.test(text)) return false;
  try {
    return new URL(text).hostname !== '';
  } catch {
    return false;
  }
}

/** Leave enclosing prose/Markdown punctuation out, keeping balanced URL brackets. */
export function findUrlCandidates(text: string): UrlCandidate[] {
  const links: UrlCandidate[] = [];
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`\\{}|^]+/gi)) {
    let uri = match[0];
    while (uri) {
      const last = uri.at(-1)!;
      const opening = last === ')' ? '(' : last === ']' ? '[' : null;
      if (
        /[.,;:!?]/.test(last) ||
        (opening && uri.split(last).length > uri.split(opening).length)
      ) {
        uri = uri.slice(0, -1);
      } else break;
    }
    if (isHttpUri(uri)) links.push({ uri, start: match.index, end: match.index + uri.length });
  }
  return links;
}

function hardContinuation(previous: MappedRow, next: MappedRow, cols: number, text: string) {
  const link = findUrlCandidates(text).at(-1);
  const tail = /\bhttps?:\/\/[^\s<>"'`\\{}|^]*$/i.exec(text)?.[0];
  // A wrap can split the host, port or filename after a dot: the unfinished
  // prefix need not itself parse as a URL. An enclosing bracket ends the link.
  if (!tail || (link && /[\])]/.test(text.slice(link.end)))) return false;
  const right = next.text.trimStart();
  if (!right || /^(?:https?:\/\/|~\/|\.{1,2}\/)/i.test(right)) return false;
  const token = right.split(/\s/, 1)[0]!.replace(/[.,;:!?\])]+$/, '');
  if (!/^[\p{L}\p{N}_%/?.:#&=+~-]/u.test(token)) return false;
  const structured = /[/_.?&#=%+~-]/.test(token);
  // Unlike file paths, URLs have no existence check. Avoid swallowing a prose
  // line's first word, or guessing a join far from the margin without a slash.
  if (!structured && /\s/.test(right.trimEnd())) return false;
  const end = previous.cells[previous.text.trimEnd().length - 1];
  return (tail.endsWith('/') && structured) || (end !== undefined && end.col >= cols - 9);
}

export function findBufferUrlCandidates(buffer: IBuffer, row0: number, cols: number) {
  return findBufferLinkCandidates(buffer, row0, cols, findUrlCandidates, hardContinuation);
}

/** Use the file-link cell mapping for both native soft wraps and TUI hard wraps. */
export function registerUrlLinks(terminal: Terminal, onOpen: (uri: string) => void): IDisposable {
  return terminal.registerLinkProvider({
    provideLinks(line, callback) {
      callback(
        findBufferUrlCandidates(terminal.buffer.active, line - 1, terminal.cols).map(
          ({ candidate, start, end }) => ({
            range: {
              start: { x: start.col + 1, y: start.row + 1 },
              end: { x: end.col + 1, y: end.row + 1 },
            },
            text: candidate.uri,
            activate: () => onOpen(candidate.uri),
          }),
        ),
      );
    },
  });
}
