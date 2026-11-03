import { describe, expect, it } from 'vitest';
import {
  findMath,
  matchMathAt,
  renderMathHtml,
} from '../../../../src/features/editor/previews/markdown/math';

describe('matchMathAt', () => {
  it('reads each delimiter pair and its mode', () => {
    expect(matchMathAt('$x+1$')).toMatchObject({ tex: 'x+1', display: false, length: 5 });
    expect(matchMathAt('$$x+1$$')).toMatchObject({ tex: 'x+1', display: true, length: 7 });
    expect(matchMathAt('\\(x+1\\)')).toMatchObject({ tex: 'x+1', display: false });
    expect(matchMathAt('\\[x+1\\]')).toMatchObject({ tex: 'x+1', display: true });
  });

  it('prefers the longer opener, so $$ is display not empty inline', () => {
    expect(matchMathAt('$$a$$')?.display).toBe(true);
  });

  it('leaves prose currency alone', () => {
    expect(matchMathAt('$5 and $10 more', 0)).toBeNull(); // space before the closer
    expect(matchMathAt('$5-$7', 0)).toBeNull(); // a digit follows the closer
    expect(matchMathAt('$ x $', 0)).toBeNull(); // padded delimiters
    expect(matchMathAt('$$', 0)).toBeNull(); // empty
  });

  it('does not close on an escaped delimiter', () => {
    expect(matchMathAt('$a\\$b$')).toMatchObject({ tex: 'a\\$b' });
    expect(matchMathAt('$only')).toBeNull();
  });

  it('closes \\[…\\] even though the closer starts with a backslash', () => {
    expect(matchMathAt('\\[a \\\\ b\\]')).toMatchObject({ tex: 'a \\\\ b', display: true });
  });

  it('refuses a span running over a blank line', () => {
    expect(matchMathAt('$a\n\nb$')).toBeNull();
  });

  it('matches only at the given offset', () => {
    expect(matchMathAt('cost $x$', 0)).toBeNull();
    expect(matchMathAt('cost $x$', 5)).toMatchObject({ tex: 'x' });
  });
});

describe('findMath', () => {
  it('finds the next span and where it starts', () => {
    expect(findMath('total is $x^2$ today')).toMatchObject({ start: 9, tex: 'x^2' });
  });

  it('walks past prose dollars to real maths', () => {
    expect(findMath('it costs $5 or $6, unless $n$ of them')).toMatchObject({ tex: 'n' });
  });

  it('resumes after a span', () => {
    const first = findMath('$a$ and $b$')!;
    expect(findMath('$a$ and $b$', first.start + first.length)).toMatchObject({ tex: 'b' });
  });

  it('returns null for prose', () => {
    expect(findMath('no maths here, just a \\ and a $')).toBeNull();
  });
});

describe('renderMathHtml', () => {
  it('typesets to KaTeX HTML labelled with its source', () => {
    const html = renderMathHtml('a_1', false);
    expect(html).toContain('class="math"');
    expect(html).toContain('role="math"');
    expect(html).toContain('aria-label="a_1"');
    expect(html).toContain('class="katex"');
  });

  it('marks display maths for the block rule', () => {
    expect(renderMathHtml('a', true)).toContain('class="math math-display"');
  });

  it('escapes the source in the label', () => {
    expect(renderMathHtml('a < "b"', false)).toContain('aria-label="a &lt; &quot;b&quot;"');
  });

  it('renders a broken expression in place instead of throwing', () => {
    const html = renderMathHtml('\\frac{', false);
    expect(html).toContain('katex-error');
    expect(html).toContain('ParseError');
  });

  it('carries macros across expressions', () => {
    // An undefined control sequence is not a parse error: KaTeX prints the
    // token itself in the error colour and renders the rest.
    const macros = {};
    renderMathHtml('\\gdef\\pud{\\alpha}', false, macros);
    expect(renderMathHtml('\\pud', false, macros)).not.toContain('var(--danger)');
    expect(renderMathHtml('\\pud', false, {})).toContain('var(--danger)');
  });

  it('does not honour \\href, whose URL would reach the unsanitised iframe', () => {
    // The command prints as inert text; the URL survives only inside the
    // aria-label, which is a string, not a reference.
    const html = renderMathHtml('\\href{javascript:alert(1)}{x}', false);
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href=');
  });
});
