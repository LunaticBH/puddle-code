import type { IBuffer } from '@xterm/xterm';
import type { HostPathStyle } from '@puddle/shared';
import { findPathCandidates } from './file-link-paths';
import { findBufferLinkCandidates, type MappedRow } from './link-buffer';

/** The characters that may end and begin a wrapped path, and what starts a new one. */
interface ContinuationRules {
  left: RegExp;
  right: RegExp;
  fresh: RegExp;
  separator: RegExp;
}

const POSIX_RULES: ContinuationRules = {
  left: /[\w.+@~/:-]$/,
  right: /^[\w.+@~:-]/,
  fresh: /^(?:~\/|\.{1,2}\/)/,
  separator: /\/$/,
};

// A Windows host's paths also break after `\`, and a drive or UNC prefix (like
// `.\` and `~\`) begins a path of its own.
const WIN32_RULES: ContinuationRules = {
  left: /[\w.+@~/\\:-]$/,
  right: /^[\w.+@~:-]/,
  fresh: /^(?:~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\)/,
  separator: /[\\/]$/,
};

/**
 * TUIs wrap within a content area, leaving a gutter and repeating indentation.
 * Also allow a deliberate break after a directory separator. Resolution still
 * validates every joined path; individual logical lines remain fallbacks.
 */
function hardContinuation(
  rules: ContinuationRules,
  previous: MappedRow,
  next: MappedRow,
  cols: number,
): boolean {
  const left = previous.text.trimEnd();
  const right = next.text.trimStart();
  if (!rules.left.test(left) || !rules.right.test(right)) return false;
  // A new absolute/explicit relative path is its own link, not a continuation.
  if (rules.fresh.test(right)) return false;
  const end = previous.cells[left.length - 1];
  return rules.separator.test(left) || (end !== undefined && end.col >= cols - 9);
}

/**
 * File paths retain resolve-validated alternatives for ambiguous TUI wraps.
 * `style` is the HOST's path style; POSIX hosts keep their original rules.
 */
export function findBufferPathCandidates(
  buffer: IBuffer,
  row0: number,
  cols: number,
  style: HostPathStyle = 'posix',
) {
  const rules = style === 'win32' ? WIN32_RULES : POSIX_RULES;
  return findBufferLinkCandidates(
    buffer,
    row0,
    cols,
    (text) => findPathCandidates(text, style),
    (previous, next, width) => hardContinuation(rules, previous, next, width),
  );
}
