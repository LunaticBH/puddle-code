import { describe, expect, it } from 'vitest';
import { annotateHtmlSourceLocations } from '../../../../src/features/editor/previews/html/html-source-locations';

describe('HTML source locations', () => {
  it('annotates authored elements and records the document line count', () => {
    const html = annotateHtmlSourceLocations('<main>\n  <h1>Hello</h1>\n  <p>World</p>\n</main>');
    expect(html).toContain('data-puddle-source-line-count="4"');
    expect(html).toContain('<main data-puddle-source-line="1" data-puddle-source-end-line="4">');
    expect(html).toContain('<h1 data-puddle-source-line="2" data-puddle-source-end-line="2">');
    expect(html).toContain('<p data-puddle-source-line="3" data-puddle-source-end-line="3">');
  });

  it('does not invent a source location for parser-created structure', () => {
    const html = annotateHtmlSourceLocations('plain text');
    expect(html).toContain('<html data-puddle-source-line-count="1">');
    expect(html).not.toContain('<body data-puddle-source-line=');
  });

  it('overwrites authored reserved attributes and tolerates malformed HTML', () => {
    const html = annotateHtmlSourceLocations(
      '<section data-puddle-source-line="999"><b>one\n<div>two',
    );
    expect(html).toContain('<section data-puddle-source-line="1"');
    expect(html).not.toContain('data-puddle-source-line="999"');
    expect(html).toContain('<div data-puddle-source-line="2"');
  });
});
