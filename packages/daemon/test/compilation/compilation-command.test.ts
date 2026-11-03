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

  it('keeps Windows backslashes literal and prefers double quotes on Windows', () => {
    expect(
      parseCommandTemplate('C:\\Tools\\gcc.exe "C:\\Program Files\\out\\" {{source}}', 'win32'),
    ).toEqual(['C:\\Tools\\gcc.exe', 'C:\\Program Files\\out\\', '{{source}}']);
    const words = ['-outdir={{output_dir}}', 'say "hi"', `it's "both"`, ''];
    const template = commandTemplate('C:\\Program Files\\MiKTeX\\latexmk.exe', words, 'win32');
    expect(template).toBe(
      `"C:\\Program Files\\MiKTeX\\latexmk.exe" -outdir={{output_dir}} 'say "hi"' ` +
        `"it's "'"'"both"'"'"" ""`,
    );
    expect(parseCommandTemplate(template, 'win32')).toEqual([
      'C:\\Program Files\\MiKTeX\\latexmk.exe',
      ...words,
    ]);
    expect(commandTemplate('C:\\Python312\\python.exe', ['-u'], 'win32')).toBe(
      'C:\\Python312\\python.exe -u',
    );
    // POSIX keeps sh escaping.
    expect(parseCommandTemplate('a\\ b C:\\x', 'linux')).toEqual(['a b', 'C:x']);
    expect(() => parseCommandTemplate('gcc main.c && main.exe', 'win32')).toThrow(
      /without a shell/,
    );
  });

  it('rejects shell composition and unknown placeholders', () => {
    expect(() => parseCommandTemplate('latexmk main.tex && open main.pdf')).toThrow(
      /without a shell/,
    );
    expect(() => expandCommandTemplate('latexmk {{mystery}}', {})).toThrow(/Unknown/);
  });
});
