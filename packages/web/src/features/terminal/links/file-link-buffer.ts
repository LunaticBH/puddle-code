import type { IBuffer } from '@xterm/xterm';
import { findPathCandidates } from './file-link-paths';
import { findBufferLinkCandidates, type MappedRow } from './link-buffer';

/**
 * TUIs wrap within a content area, leaving a gutter and repeating indentation.
 * Also allow a deliberate break after a directory separator. Resolution still
 * validates every joined path; individual logical lines remain fallbacks.
 */
function hardContinuation(previous: MappedRow, next: MappedRow, cols: number): boolean {
  const left = previous.text.trimEnd();
  const right = next.text.trimStart();
  if (!/[\w.+@~/:-]$/.test(left) || !/^[\w.+@~:-]/.test(right)) return false;
  // A new absolute/explicit relative path is its own link, not a continuation.
  if (/^(?:~\/|\.{1,2}\/)/.test(right)) return false;
  const end = previous.cells[left.length - 1];
  return left.endsWith('/') || (end !== undefined && end.col >= cols - 9);
}

/** File paths retain resolve-validated alternatives for ambiguous TUI wraps. */
export function findBufferPathCandidates(buffer: IBuffer, row0: number, cols: number) {
  return findBufferLinkCandidates(buffer, row0, cols, findPathCandidates, hardContinuation);
}
