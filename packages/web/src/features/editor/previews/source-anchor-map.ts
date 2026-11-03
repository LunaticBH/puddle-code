/** Source coordinates are one-based lines and may be fractional between lines. */
export interface SourceAnchor {
  line: number;
  offset: number;
}

export const SOURCE_LINE_ATTRIBUTE = 'data-puddle-source-line';
export const SOURCE_END_LINE_ATTRIBUTE = 'data-puddle-source-end-line';
export const SOURCE_LINE_COUNT_ATTRIBUTE = 'data-puddle-source-line-count';

function finiteAnchor(anchor: SourceAnchor): boolean {
  return Number.isFinite(anchor.line) && Number.isFinite(anchor.offset);
}

/**
 * Turn DOM-order measurements into one monotonic source/rendered axis.
 * Nested blocks commonly repeat a line or pixel offset; keeping the earliest
 * occurrence gives interpolation an unambiguous top edge without inventing
 * jumps for hidden or parser-generated nodes.
 */
export function normaliseSourceAnchors(anchors: readonly SourceAnchor[]): SourceAnchor[] {
  const ordered = anchors
    .filter(finiteAnchor)
    .map(({ line, offset }) => ({ line: Math.max(1, line), offset: Math.max(0, offset) }))
    .sort((a, b) => a.offset - b.offset || a.line - b.line);
  const result: SourceAnchor[] = [];
  for (const anchor of ordered) {
    const previous = result.at(-1);
    if (previous && (anchor.line < previous.line || anchor.offset < previous.offset)) continue;
    if (previous && (anchor.line === previous.line || anchor.offset === previous.offset)) continue;
    result.push(anchor);
  }
  return result;
}

function interpolate(
  value: number,
  lowerInput: number,
  upperInput: number,
  lowerOutput: number,
  upperOutput: number,
): number {
  if (upperInput <= lowerInput) return lowerOutput;
  const progress = Math.min(1, Math.max(0, (value - lowerInput) / (upperInput - lowerInput)));
  return lowerOutput + progress * (upperOutput - lowerOutput);
}

function surroundingAnchors(
  anchors: readonly SourceAnchor[],
  value: number,
  axis: 'line' | 'offset',
): readonly [SourceAnchor, SourceAnchor] | null {
  if (anchors.length === 0) return null;
  if (value <= anchors[0]![axis]) return [anchors[0]!, anchors[0]!];
  const last = anchors.at(-1)!;
  if (value >= last[axis]) return [last, last];

  let low = 0;
  let high = anchors.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (anchors[middle]![axis] <= value) low = middle;
    else high = middle;
  }
  return [anchors[low]!, anchors[high]!];
}

/** Piecewise source-line → rendered-pixel interpolation. */
export function offsetAtSourceLine(
  anchors: readonly SourceAnchor[],
  sourceLine: number,
): number | null {
  const pair = surroundingAnchors(anchors, sourceLine, 'line');
  if (!pair) return null;
  return interpolate(sourceLine, pair[0].line, pair[1].line, pair[0].offset, pair[1].offset);
}

/** Piecewise rendered-pixel → source-line interpolation (preview click/scroll). */
export function sourceLineAtOffset(
  anchors: readonly SourceAnchor[],
  offset: number,
): number | null {
  const pair = surroundingAnchors(anchors, offset, 'offset');
  if (!pair) return null;
  return interpolate(offset, pair[0].offset, pair[1].offset, pair[0].line, pair[1].line);
}

function attributeLine(element: Element, attribute: string): number | null {
  const value = Number(element.getAttribute(attribute));
  return Number.isFinite(value) && value >= 1 ? value : null;
}

/**
 * Measure parser-annotated DOM blocks against their real post-layout geometry.
 * Images, wrapping, fonts and authored CSS are therefore already reflected in
 * the map. Synthetic document endpoints keep sparse documents useful.
 */
export function measureSourceAnchors(
  scroller: HTMLElement,
  content: HTMLElement,
  lineCount: number,
): SourceAnchor[] {
  const scrollerTop = scroller.getBoundingClientRect().top;
  const measured: SourceAnchor[] = [{ line: 1, offset: 0 }];
  for (const element of content.querySelectorAll(`[${SOURCE_LINE_ATTRIBUTE}]`)) {
    const line = attributeLine(element, SOURCE_LINE_ATTRIBUTE);
    if (line === null || line > lineCount + 1 || element.getClientRects().length === 0) continue;
    const rect = element.getBoundingClientRect();
    const top = rect.top - scrollerTop + scroller.scrollTop;
    measured.push({ line, offset: top });

    const endLine = attributeLine(element, SOURCE_END_LINE_ATTRIBUTE);
    if (endLine !== null && endLine <= lineCount + 1 && endLine > line && rect.height > 0) {
      measured.push({ line: endLine, offset: top + rect.height });
    }
  }
  measured.push({ line: Math.max(1, lineCount + 1), offset: scroller.scrollHeight });
  return normaliseSourceAnchors(measured);
}

export function countSourceLines(text: string): number {
  return text === '' ? 1 : text.split(/\r\n?|\n/).length;
}
