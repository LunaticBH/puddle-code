import { expect, it } from 'vitest';
import { renderGuideMarkdown } from '../../src/features/guide/guide-markdown';

it.each(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])(
  'renders %s alerts inside a list, preserving paragraphs and fenced commands',
  (tag) => {
    const html = renderGuideMarkdown(
      [
        '1. Install',
        '',
        `   > [!${tag}]`,
        '   > Supported platforms.',
        '   >',
        '   > ```sh',
        '   > puddle --version',
        '   > ```',
      ].join('\n'),
    );
    expect(html).toContain(`<div class="markdown-alert markdown-alert-${tag.toLowerCase()}">`);
    expect(html).toContain('<p>Supported platforms.</p>');
    expect(html).toContain('<code class="language-sh">puddle --version\n</code>');
    expect(html).not.toContain(`[!${tag}]`);
    expect(html.indexOf('<li>')).toBeLessThan(html.indexOf('<div class="markdown-alert'));
  },
);

it('keeps raw HTML inert in body text and custom alert titles', () => {
  const html = renderGuideMarkdown(
    '> [!NOTE] <img src=x onerror=alert(1)>\n> <script>bad()</script>',
  );
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<script');
});

it('gives Markdown TOC links stable, unique heading targets on each render', () => {
  const source =
    '[Install](#cli-installation)\n\n## CLI **installation**?\n\n## CLI installation\n\n## CLI installation-1';
  const html = renderGuideMarkdown(source);
  expect(html).toContain('href="#cli-installation"');
  expect(html).toContain('<h2 id="cli-installation">');
  expect(html).toContain('<h2 id="cli-installation-1">');
  expect(html).toContain('<h2 id="cli-installation-1-1">');
  expect(renderGuideMarkdown(source)).toBe(html);
});
