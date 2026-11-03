import { describe, expect, it } from 'vitest';
import { isLatexGeneratedPdf } from '../../../src/features/editor/previews/MediaViewer';

describe('isLatexGeneratedPdf', () => {
  it('recognises generated PDFs beneath daemon LaTeX storage', () => {
    expect(isLatexGeneratedPdf('document.pdf', '/home/me/.puddle/latex/build-1')).toBe(true);
    expect(isLatexGeneratedPdf('.puddle/latex/build-1/document.PDF', '/repo')).toBe(true);
    expect(
      isLatexGeneratedPdf('document.pdf', '/srv/puddle/latex/0123456789abcdef01234567/current'),
    ).toBe(true);
    expect(isLatexGeneratedPdf('document.pdf', '/custom/output', 'latex')).toBe(true);
  });

  it('leaves ordinary PDFs on the native viewer path', () => {
    expect(isLatexGeneratedPdf('paper.pdf', '/repo')).toBe(false);
    expect(isLatexGeneratedPdf('paper.pdf')).toBe(false);
    expect(isLatexGeneratedPdf('paper.tex', '/home/me/.puddle/latex/build-1')).toBe(false);
  });
});
