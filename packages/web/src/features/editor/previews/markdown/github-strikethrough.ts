import type { Delimiter, MarkdownIt, StateInline } from 'markdown-it';

const TILDE = 0x7e;
// Delimiter matching is keyed by `marker`. Keep one- and two-character runs
// distinct so `~one~~` cannot close across unlike GFM delimiters.
const SINGLE_TILDE_DELIMITER = TILDE + 0x10000;

function tokenize(state: StateInline, silent: boolean): boolean {
  if (silent || state.src.charCodeAt(state.pos) !== TILDE) return false;

  const scanned = state.scanDelims(state.pos, true);
  const token = state.push('text', '', 0);
  token.content = '~'.repeat(scanned.length);
  state.pos += scanned.length;

  // GFM permits matching runs of exactly one or two tildes. A longer run is
  // one literal token, rather than a literal tilde wrapped around `~~`.
  if (scanned.length > 2) return true;

  state.delimiters.push({
    marker: scanned.length === 1 ? SINGLE_TILDE_DELIMITER : TILDE,
    length: 0,
    token: state.tokens.length - 1,
    end: -1,
    open: scanned.can_open,
    close: scanned.can_close,
  });
  return true;
}

function resolveDelimiters(state: StateInline, delimiters: Delimiter[]): void {
  for (const opener of delimiters) {
    if (
      (opener.marker !== TILDE && opener.marker !== SINGLE_TILDE_DELIMITER) ||
      opener.end === -1
    ) {
      continue;
    }

    const closer = delimiters[opener.end];
    if (!closer) continue;
    const markup = opener.marker === TILDE ? '~~' : '~';
    const openToken = state.tokens[opener.token];
    const closeToken = state.tokens[closer.token];
    if (!openToken || !closeToken) continue;

    openToken.type = 's_open';
    openToken.tag = 's';
    openToken.nesting = 1;
    openToken.markup = markup;
    openToken.content = '';
    closeToken.type = 's_close';
    closeToken.tag = 's';
    closeToken.nesting = -1;
    closeToken.markup = markup;
    closeToken.content = '';
  }
}

function postProcess(state: StateInline): void {
  resolveDelimiters(state, state.delimiters);
  for (const metadata of state.tokens_meta) {
    if (metadata?.delimiters) resolveDelimiters(state, metadata.delimiters);
  }
}

/** Replace markdown-it's double-only rule with GFM's exact one-or-two form. */
export function installGithubStrikethrough(parser: MarkdownIt): void {
  parser.inline.ruler.at('strikethrough', tokenize);
  parser.inline.ruler2.at('strikethrough', postProcess);
}
