import { describe, expect, it } from 'vitest';
import { markdownToHtml } from '../../../../src/features/editor/previews/markdown/markdown';

describe('markdownToHtml', () => {
  it('renders headings, emphasis, and links', () => {
    const html = markdownToHtml('# Title\n\nSome *very* [linked](https://example.com) text.');
    expect(html).toContain('>Title</h1>');
    expect(html).toContain('<em>very</em>');
    expect(html).toContain('<a href="https://example.com">linked</a>');
  });

  it('renders GFM tables and fenced code', () => {
    const html = markdownToHtml('| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```');
    expect(html).toContain('<table ');
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('class="language-js"');
  });

  it('annotates rendered blocks with one-based source ranges', () => {
    const html = markdownToHtml('# First\n\nParagraph\ncontinued');
    expect(html).toContain('data-puddle-source-line="1"');
    expect(html).toContain('data-puddle-source-end-line="2"');
    expect(html).toContain('data-puddle-source-line="3"');
    expect(html).toContain('data-puddle-source-end-line="5"');
  });

  it('keeps GFM autolinks and task-list checkboxes', () => {
    expect(markdownToHtml('https://example.com')).toContain('<a href="https://example.com">');
    const task = markdownToHtml('- [x] shipped\n- [ ] pending');
    expect(task).toContain('<input type="checkbox" disabled checked>');
    expect(task).toContain('<input type="checkbox" disabled>');
  });

  it('renders GitHub footnotes with accessible, document-scoped anchors', () => {
    const html = markdownToHtml(
      'Here is a simple footnote[^1].\n\n[^1]: My reference.  \nThis is a second line.',
      'preview-a',
    );
    expect(html).toContain('href="#fn-preview-a-1"');
    expect(html).toContain('id="fn-preview-a-1"');
    expect(html).toContain('data-footnote-ref');
    expect(html).toContain('>1</a>');
    expect(html).not.toContain('>[1]</a>');
    expect(html).toContain('<br>\nThis is a second line.');
    expect(html).toContain('data-footnote-backref-idx="1"');
    expect(html).toContain('aria-label="Back to reference 1"');
  });

  it('leaves Pandoc inline footnotes as prose, matching GitHub', () => {
    const html = markdownToHtml('This is not a footnote.^[Written here.]');
    expect(html).toContain('.^[Written here.]');
    expect(html).not.toContain('class="footnote-ref"');
  });

  it('renders GFM strikethrough with one or two tildes only', () => {
    expect(markdownToHtml('~one~ and ~~two~~')).toContain('<s>one</s> and <s>two</s>');
    expect(markdownToHtml('Keep ~~~three~~~ literal.')).toContain('Keep ~~~three~~~ literal.');
    expect(markdownToHtml('Keep ~~~three~~~ literal.')).not.toContain('<s>');
    expect(markdownToHtml('~one~~')).not.toContain('<s>');
  });

  it('renders the five GitHub alert types and leaves other quotes alone', () => {
    const html = markdownToHtml(
      '> [!NOTE]\n> Note text.\n\n> [!TIP]\n> Tip text.\n\n> [!IMPORTANT]\n> Important text.\n\n> [!WARNING]\n> Warning text.\n\n> [!CAUTION]\n> Caution text.',
    );
    for (const type of ['note', 'tip', 'important', 'warning', 'caution']) {
      expect(html).toContain(`class="markdown-alert markdown-alert-${type}"`);
    }
    expect(markdownToHtml('> Ordinary quote.')).toContain('<blockquote');
    expect(markdownToHtml('> [!note]\n> Lowercase stays a quote.')).toContain('<blockquote');
  });

  it('renders double-equals highlights outside code', () => {
    expect(markdownToHtml('Read ==this part==.')).toContain('<mark>this part</mark>');
    expect(markdownToHtml('`==not this part==`')).not.toContain('<mark>');
  });

  it('marks Mermaid fences for deferred browser rendering', () => {
    const html = markdownToHtml('```mermaid\ngraph TD\n  A[<unsafe>] --> B\n```');
    expect(html).toContain('class="mermaid-diagram"');
    expect(html).toContain('data-puddle-mermaid=""');
    expect(html).toContain('A[&lt;unsafe&gt;]');
    expect(html).not.toContain('class="language-mermaid"');
  });

  it('does not treat single newlines as hard breaks (breaks: false)', () => {
    expect(markdownToHtml('one\ntwo')).not.toContain('<br');
  });

  it('typesets inline and display maths', () => {
    expect(markdownToHtml('mass $E=mc^2$ today')).toContain('class="katex"');
    expect(markdownToHtml('$$\n\\int_0^1 x\\,dx\n$$')).toContain('math math-display');
    expect(markdownToHtml('\\(a+b\\)')).toContain('class="katex"');
    expect(markdownToHtml('```math\nx^2\n```')).toContain('math math-display');
  });

  it('claims maths before the emphasis and escape rules can chew on it', () => {
    const html = markdownToHtml('$a_1 + b_2$');
    expect(html).not.toContain('<em>');
    expect(html).toContain('aria-label="a_1 + b_2"');
  });

  it('leaves maths inside code spans and fences as text', () => {
    expect(markdownToHtml('`$x$`')).not.toContain('class="katex"');
    expect(markdownToHtml('```\n$x$\n```')).not.toContain('class="katex"');
  });

  it('leaves prose dollars alone', () => {
    expect(markdownToHtml('it costs $5 or $10 today')).not.toContain('class="katex"');
  });

  it('keeps macros within one document', () => {
    // `\gdef` in a preamble expression holds for the rest of the file...
    expect(markdownToHtml('$\\gdef\\pud{\\alpha}$ then $\\pud$')).not.toContain('var(--danger)');
    // ...and never leaks into the next one (undefined macros print in the
    // error colour).
    expect(markdownToHtml('$\\pud$')).toContain('var(--danger)');
  });

  it('passes raw HTML through for the sanitiser to handle', () => {
    // Sanitisation is DOMPurify's job in FilePreview (needs a browser DOM);
    // the parser itself must not be relied on to strip anything.
    expect(markdownToHtml('hello <script>alert(1)</script>')).toContain('<script>');
  });
});
