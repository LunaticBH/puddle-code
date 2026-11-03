import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HoverMarquee } from '../../src/components/hover-marquee';

describe('rich hover marquee', () => {
  it('keeps differently styled text inside one clipping and motion surface', () => {
    const html = renderToStaticMarkup(
      createElement(
        HoverMarquee,
        { text: 'puddle packages/web', hoverClass: 'group-hover:translate-x-1' },
        createElement('strong', null, 'puddle'),
        ' ',
        createElement('span', null, 'packages/web'),
      ),
    );

    expect(html).toContain('<strong>puddle</strong> <span>packages/web</span>');
    expect(html.match(/overflow-hidden/g)).toHaveLength(1);
    expect(html.match(/transition-transform/g)).toHaveLength(1);
  });
});
