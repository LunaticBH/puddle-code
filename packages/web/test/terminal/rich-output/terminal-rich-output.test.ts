import { describe, expect, it, vi } from 'vitest';
import { terminalRichBlocks } from '../../../src/features/terminal/rich-output/rich-output-buffer';
import { bufferWithLines } from '../../helpers/terminal-buffer';

function scan(text: string, viewport = 0, visibleRows = 24) {
  const buffer = bufferWithLines(
    text.split('\n').map((text) => ({ text })),
    100,
  );
  return terminalRichBlocks(buffer, 100, viewport, visibleRows);
}

describe('terminal rich output', () => {
  it('recognises an unfenced flowchart with subgraphs and blank lines, stopping at prose', () => {
    const source =
      'flowchart TB\n  A[User]\n\n  subgraph APP[Application]\n    B[Model]\n  end\n\n  A <--> B';
    const blocks = scan(`Unsupported diagram:\n${source}\n\nThe next paragraph.`);
    expect(blocks).toEqual([
      expect.objectContaining({
        kind: 'mermaid',
        source,
        start: { row: 1, col: 0 },
        end: { row: 8, col: 9 },
      }),
    ]);
  });

  it('recognises raw sequence diagrams without swallowing the following prompt', () => {
    const source =
      'sequenceDiagram\n  participant Client\n  Client->>Server: Hello\n  Server-->>Client: Reply';
    expect(scan(`${source}\n› Continue`)[0]?.source).toBe(source);
  });

  it('supports fenced Mermaid diagram types and fenced LaTeX', () => {
    expect(scan('```mermaid\npie\n  "A" : 10\n```')[0]).toMatchObject({
      kind: 'mermaid',
      source: 'pie\n  "A" : 10',
    });
    for (const language of ['math', 'latex', 'tex'])
      expect(scan(`~~~${language}\nx^2\n~~~`)[0]).toMatchObject({
        kind: 'math',
        source: 'x^2',
        display: true,
      });
  });

  it('waits for closing fences and leaves ordinary code examples alone', () => {
    expect(scan('```mermaid\nflowchart TB\n  A --> B')).toEqual([]);
    expect(scan('```sh\necho "$x$"\nflowchart TB\n  A --> B\n```')).toEqual([]);
    expect(scan('`$x$` and \\$5 or $10')).toEqual([]);
    expect(scan('``$x$`` and `$y$`')).toEqual([]);
    expect(scan('```sh title=example\necho "$x$"\n```')).toEqual([]);
  });

  it('recognises display equations with indentation and preserves the source TeX', () => {
    const source = 'J\\ddot e+(b+K_D)\\ddot e+K_P\\dot e+K_Ie=0.';
    expect(scan(`  $$\n  ${source}\n  $$`)[0]).toMatchObject({
      kind: 'math',
      source,
      display: true,
      start: { row: 0, col: 0 },
      end: { row: 2, col: 3 },
    });
    expect(scan('\\[\na^2+b^2=c^2\n\\]')[0]?.source).toBe('a^2+b^2=c^2');
    expect(scan('  $$a^2+\n  b^2=c^2$$')[0]?.source).toBe('a^2+\nb^2=c^2');
    expect(scan('$$\nx^2')).toEqual([]);
  });

  it('locates inline maths precisely and leaves currency untouched', () => {
    const blocks = scan('cost $5 or $10; then $K_{P}$ and \\(x^2\\)');
    expect(blocks.map((block) => block.source)).toEqual(['K_{P}', 'x^2']);
    expect(blocks[0]).toMatchObject({
      start: { row: 0, col: 21 },
      end: { row: 0, col: 27 },
      display: false,
    });
  });

  it('joins soft-wrapped TeX without inserting whitespace', () => {
    const buffer = bufferWithLines(
      [{ text: '$$abcdefgh' }, { text: 'ijk$$', isWrapped: true }],
      10,
    );
    expect(terminalRichBlocks(buffer, 10, 0, 2)[0]).toMatchObject({
      source: 'abcdefghijk',
      start: { row: 0, col: 0 },
      end: { row: 1, col: 4 },
    });
  });

  it('does not cover adjacent prose with a multiline inline equation', () => {
    const buffer = bufferWithLines(
      [{ text: 'text $abcd' }, { text: 'ef$ after', isWrapped: true }],
      10,
    );
    expect(terminalRichBlocks(buffer, 10, 0, 2)).toEqual([]);
  });

  it('recovers partially visible blocks but excludes blocks outside the viewport', () => {
    const text = '$$\nx^2\n$$\nprose\n$$y$$';
    expect(scan(text, 1, 1).map((block) => block.source)).toEqual(['x^2']);
    expect(scan(text, 3, 1)).toEqual([]);
  });

  it('bounds reads independently of scrollback length and caps dense inline maths', () => {
    const buffer = bufferWithLines(
      Array.from({ length: 20_000 }, () => ({ text: 'ordinary output' })),
      80,
    );
    const getLine = vi.spyOn(buffer, 'getLine');
    expect(terminalRichBlocks(buffer, 80, 10_000, 24)).toEqual([]);
    expect(getLine.mock.calls.length).toBeLessThan(1000);
    expect(scan(Array(60).fill('$x$').join(' '))).toHaveLength(25);
    expect(scan(Array(60).fill('$x$').join('\n'), 0, 60)).toHaveLength(32);
  });

  it('reserves scan capacity for the viewport on a wide, densely filled terminal', () => {
    const rows = Array.from({ length: 200 }, () => ({ text: 'x'.repeat(500) }));
    rows[128] = { text: '$$x^2$$' };
    expect(terminalRichBlocks(bufferWithLines(rows, 500), 500, 128, 24)[0]?.source).toBe('x^2');
  });
});
