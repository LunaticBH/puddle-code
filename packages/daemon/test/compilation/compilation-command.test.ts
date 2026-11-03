import { describe, expect, it } from 'vitest';
import {
  commandTemplate,
  expandCommandTemplate,
  parseCommandTemplate,
} from '../../src/compilation/command-template.js';

describe('compilation command templates', () => {
  it('round-trips quoted argv and expands managed values without a shell', () => {
    const template = commandTemplate('/Applications/TeX Live/latexmk', [
      '-outdir={{output_dir}}',
      '{{source}}',
    ]);
    expect(parseCommandTemplate(template)).toEqual([
      '/Applications/TeX Live/latexmk',
      '-outdir={{output_dir}}',
      '{{source}}',
    ]);
    expect(
      expandCommandTemplate(template, {
        source: '/repo with spaces/main.tex',
        output_dir: '/repo with spaces/.puddle/run',
      }),
    ).toEqual({
      file: '/Applications/TeX Live/latexmk',
      args: ['-outdir=/repo with spaces/.puddle/run', '/repo with spaces/main.tex'],
    });
  });

  it('rejects shell composition and unknown placeholders', () => {
    expect(() => parseCommandTemplate('latexmk main.tex && open main.pdf')).toThrow(
      /without a shell/,
    );
    expect(() => expandCommandTemplate('latexmk {{mystery}}', {})).toThrow(/Unknown/);
  });
});
