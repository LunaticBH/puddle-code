import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GraphCell, ContinuationCell } from '../../src/features/changes/commit-graph-cell';
import { computeCommitGraph } from '../../src/features/changes/commit-graph-layout';

describe('commit graph SVG', () => {
  // A topic merges main before being merged back into main. The inner merge
  // joins a lane that is already carrying the outer merge's first parent.
  const { rows } = computeCommitGraph([
    { sha: 'outer', parents: ['main', 'topic'] },
    { sha: 'topic', parents: ['topic-base', 'main'] },
    { sha: 'topic-base', parents: ['base'] },
    { sha: 'main', parents: ['base'] },
    { sha: 'base', parents: [] },
  ]);

  it('keeps an existing lane continuous when a merge joins it', () => {
    const html = renderToStaticMarkup(createElement(GraphCell, { row: rows[1]!, width: 35 }));

    // Main's lane must reach the bottom of the row, where the merge joins it.
    expect(html).toContain('d="M 7 0 L 7 40"');
    expect(html).toContain('d="M 21 20 C 21 30, 7 30, 7 40"');
  });

  it('continues both lanes through expanded file rows after the merge', () => {
    const html = renderToStaticMarkup(
      createElement(ContinuationCell, { lanes: rows[1]!.below, width: 35 }),
    );
    expect(html).toContain('d="M 7 0 L 7 22"');
    expect(html).toContain('d="M 21 0 L 21 22"');
  });

  it('ends incoming lanes at their commit instead of carrying them past a root', () => {
    const html = renderToStaticMarkup(createElement(GraphCell, { row: rows[4]!, width: 35 }));
    expect(html).toContain('d="M 7 0 L 7 20"');
    expect(html).toContain('d="M 21 0 C 21 10, 7 10, 7 20"');
    expect(html.match(/<path /g)).toHaveLength(2);
  });
});
