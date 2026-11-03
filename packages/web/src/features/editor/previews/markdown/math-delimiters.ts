/** A LaTeX span found at some offset: what to render, and how much it ate. */
export type MathMatch = { length: number; tex: string; display: boolean };

/** Opener, closer, display mode — longest opener first, so `$$` beats `$`. */
const PAIRS: ReadonlyArray<readonly [string, string, boolean]> = [
  ['$$', '$$', true],
  ['\\[', '\\]', true],
  ['\\(', '\\)', false],
  ['$', '$', false],
];

/** Characters that can open maths — the cheap test before `matchMathAt`. */
export function couldOpenMath(ch: string): boolean {
  return ch === '$' || ch === '\\';
}

/**
 * The maths starting exactly at `at`, or null. `$…$` follows pandoc's rules
 * for telling maths from prose currency: no whitespace just inside either
 * delimiter, no digit straight after the closing `$` (so `$5-$7` stays prose),
 * and no blank line inside. Escaped delimiters (`\$`) never close a span.
 */
export function matchMathAt(src: string, at = 0): MathMatch | null {
  for (const [open, close, display] of PAIRS) {
    if (!src.startsWith(open, at)) continue;
    const from = at + open.length;
    const end = findClosing(src, from, close);
    if (end < 0) continue;
    const tex = src.slice(from, end);
    if (tex.trim() === '' || /\n[ \t]*\n/.test(tex)) continue;
    if (open === '$' && !isTightSpan(tex, src[end + close.length])) continue;
    return { length: end + close.length - at, tex, display };
  }
  return null;
}

/** The next maths at or after `from`, or null — the text-node scanner's step. */
export function findMath(text: string, from = 0): (MathMatch & { start: number }) | null {
  for (let i = from; i < text.length; i++) {
    if (!couldOpenMath(text[i]!)) continue;
    const match = matchMathAt(text, i);
    if (match) return { ...match, start: i };
  }
  return null;
}

/**
 * The closing delimiter's offset, or -1. A backslash escapes the character
 * after it, so `\$` cannot close `$…$` — but the closer is tested first, so a
 * `\]` still closes `\[…\]`.
 */
function findClosing(src: string, from: number, close: string): number {
  for (let i = from; i < src.length; i++) {
    if (src.startsWith(close, i)) return i;
    if (src[i] === '\\') i++;
  }
  return -1;
}

function isTightSpan(tex: string, after: string | undefined): boolean {
  return !/^\s|\s$/.test(tex) && !(after !== undefined && /\d/.test(after));
}
