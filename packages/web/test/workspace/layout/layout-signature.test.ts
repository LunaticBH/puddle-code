import { describe, expect, it } from 'vitest';
import type { LayoutNode, TabRef } from '@puddle/shared';
import { layoutSignature } from '../../../src/features/workspace/layout/layout-signature';
import { makeLeaf } from '../../../src/features/workspace/layout/layout-tree';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

const term = (session: string): TabRef => ({ type: 'terminal', session });
const ed = (session: string, path: string): TabRef => ({ type: 'editor', tab: { session, path } });
const split = (
  direction: 'row' | 'col',
  children: LayoutNode[],
  sizes: number[],
  id = 'split-id',
): LayoutNode => ({ kind: 'split', id, direction, children, sizes });

describe('layoutSignature', () => {
  it('ignores node ids and focus state', () => {
    const a = makeLeaf([term(S1), ed(S2, 'a.ts')], `term:${S1}`);
    const b = {
      ...makeLeaf([term(S1), ed(S2, 'a.ts')]),
      activeKey: null,
      previewKey: `term:${S1}`,
    };
    expect(a.id).not.toBe(b.id);
    expect(layoutSignature(a)).toBe(layoutSignature(b));
  });

  it('distinguishes tab sets, order, direction, and proportions', () => {
    const base = makeLeaf([term(S1)]);
    expect(layoutSignature(base)).not.toBe(layoutSignature(makeLeaf([term(S2)])));
    expect(layoutSignature(makeLeaf([term(S1), ed(S2, 'a.ts')]))).not.toBe(
      layoutSignature(makeLeaf([ed(S2, 'a.ts'), term(S1)])),
    );
    const row = split('row', [makeLeaf([term(S1)]), makeLeaf([term(S2)])], [50, 50]);
    const col = split('col', [makeLeaf([term(S1)]), makeLeaf([term(S2)])], [50, 50]);
    const wide = split('row', [makeLeaf([term(S1)]), makeLeaf([term(S2)])], [70, 30]);
    expect(layoutSignature(row)).not.toBe(layoutSignature(col));
    expect(layoutSignature(row)).not.toBe(layoutSignature(wide));
  });

  it('tolerates sub-0.1 size noise from resize drags', () => {
    const children = () => [makeLeaf([term(S1)]), makeLeaf([term(S2)])];
    const a = split('row', children(), [33.333333, 66.666667]);
    const b = split('row', children(), [33.3334, 66.6666], 'other-id');
    expect(layoutSignature(a)).toBe(layoutSignature(b));
  });

  it('ignores following-slot retargets but distinguishes linked from locked', () => {
    const following = (view: 'linked' | 'locked', session: string, path: string): TabRef => ({
      type: 'editor',
      tab: { view, session, path },
    });
    expect(layoutSignature(makeLeaf([following('locked', S1, 'a.md')]))).toBe(
      layoutSignature(makeLeaf([following('locked', S2, 'docs/b.md')])),
    );
    expect(layoutSignature(makeLeaf([following('linked', S1, 'a.md')]))).not.toBe(
      layoutSignature(makeLeaf([following('locked', S1, 'a.md')])),
    );
  });

  it('signs an empty leaf the same as a null tree', () => {
    expect(layoutSignature(makeLeaf([]))).toBe(layoutSignature(null));
    expect(layoutSignature(makeLeaf([term(S1)]))).not.toBe(layoutSignature(null));
  });
});
