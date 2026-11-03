/**
 * Pure-logic tests for the commit-graph lane layout (SPEC §8, Changes
 * navigator). SVG continuity is covered separately in commit-graph-cell.test.ts;
 * everything here is pure geometry.
 */
import { describe, expect, it } from 'vitest';
import { computeCommitGraph, laneColour } from '../../src/features/changes/commit-graph-layout';

const commit = (sha: string, parents: string[]) => ({ sha, parents });

describe('computeCommitGraph', () => {
  it('lays out linear history in a single column', () => {
    const { rows, laneCount } = computeCommitGraph([
      commit('c', ['b']),
      commit('b', ['a']),
      commit('a', []),
    ]);
    expect(laneCount).toBe(1);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0]);
    // Every non-root commit re-emits its single parent in its own column.
    expect(rows[0]!.created).toEqual([0]);
    expect(rows[0]!.below.map((l) => l.sha)).toEqual(['b']);
    // The root commit ends its lane (nothing below).
    expect(rows[2]!.below).toEqual([]);
    expect(rows[2]!.created).toEqual([]);
  });

  it('assigns the first parent the node column and reuses the same colour', () => {
    const { rows } = computeCommitGraph([commit('b', ['a']), commit('a', [])]);
    expect(rows[0]!.colour).toBe(rows[0]!.below[0]!.colour);
    expect(rows[0]!.colour).toBe(laneColour(0));
  });

  it('opens a second lane for a merge commit and reconverges', () => {
    // m merges topic(t) into main; both t and its base b lead back to a.
    //   m (parents main-tip `1`, topic-tip `t`)
    //   1 (parent b)   t (parent b)
    //   b (parent a)
    //   a
    const { rows, laneCount } = computeCommitGraph([
      commit('m', ['1', 't']),
      commit('1', ['b']),
      commit('t', ['b']),
      commit('b', ['a']),
      commit('a', []),
    ]);
    expect(laneCount).toBe(2);
    const m = rows[0]!;
    expect(m.col).toBe(0);
    // Two parents → two below-lanes, both created at this node.
    expect(m.created.length).toBe(2);
    expect(m.below.map((l) => l.sha).sort()).toEqual(['1', 't']);
    // By the time `b` is reached, both branches converge back to one lane.
    const b = rows[3]!;
    expect(b.above.filter((l) => l.sha === 'b').length).toBe(2);
    expect(b.below.map((l) => l.sha)).toEqual(['a']);
  });

  it('tolerates commits whose parents are outside the loaded window', () => {
    // `a`'s parent isn't loaded — the lane simply trails off below.
    const { rows } = computeCommitGraph([commit('a', ['older'])]);
    expect(rows[0]!.below.map((l) => l.sha)).toEqual(['older']);
    expect(rows).toHaveLength(1);
  });

  it('treats a missing parents field as a root commit', () => {
    const { rows } = computeCommitGraph([{ sha: 'a' }]);
    expect(rows[0]!.below).toEqual([]);
  });
});

describe('laneColour', () => {
  it('cycles through the palette and only ever returns token var() strings', () => {
    expect(laneColour(0)).toBe(laneColour(6));
    for (let i = 0; i < 12; i++) expect(laneColour(i)).toMatch(/^var\(--[\w-]+\)$/);
  });
});
