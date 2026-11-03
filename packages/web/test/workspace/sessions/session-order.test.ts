/**
 * Pure-logic tests for the sessions-sidebar ordering (SPEC §8): a persisted
 * user order with new (untracked) sessions floating to the top, newest-first,
 * plus the drag-move id reordering.
 */
import { describe, expect, it } from 'vitest';
import type { Session, SessionStatus } from '@puddle/shared';
import {
  mergeOrder,
  moveWithinGroups,
  orderSessions,
  reorderIds,
} from '../../../src/features/workspace/sessions/session-order';

function session(id: string, createdAt: string, status: SessionStatus = 'running'): Session {
  return {
    id,
    project_id: 'p',
    account_id: 1,
    worktree_path: `/wt/${id}`,
    base_branch: 'main',
    branch: id,
    separate_branch: true,
    agent_type: 'claude-code',
    agent_session_ref: null,
    title: id,
    status,
    skip_permissions: false,
    created_at: createdAt,
    updated_at: createdAt,
    last_activity_at: null,
  };
}

describe('orderSessions', () => {
  const a = session('a', '2026-07-14T08:00:00.000Z');
  const b = session('b', '2026-07-14T09:00:00.000Z');
  const c = session('c', '2026-07-14T10:00:00.000Z');

  it('with no saved order, sorts newest-created first (new-on-top default)', () => {
    expect(orderSessions([a, b, c], []).map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('follows the saved order for tracked sessions', () => {
    expect(orderSessions([a, b, c], ['c', 'a', 'b']).map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('floats an untracked (new) session above the saved order, newest-first', () => {
    // a, b are tracked; c is brand-new (not in order) → on top.
    expect(orderSessions([a, b, c], ['b', 'a']).map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('puts multiple new sessions on top newest-first, above tracked ones', () => {
    const d = session('d', '2026-07-14T11:00:00.000Z');
    expect(orderSessions([a, b, c, d], ['a', 'b']).map((s) => s.id)).toEqual(['d', 'c', 'a', 'b']);
  });

  it('ignores ids in the order that are no longer present', () => {
    expect(orderSessions([a, b], ['gone', 'b', 'a']).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('does not mutate its input', () => {
    const input = [a, b, c];
    orderSessions(input, ['c', 'b', 'a']);
    expect(input.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('reorderIds', () => {
  it('moves an id to sit immediately before another', () => {
    expect(reorderIds(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(reorderIds(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op when the ids match', () => {
    expect(reorderIds(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op when the target is missing', () => {
    expect(reorderIds(['a', 'b', 'c'], 'a', 'zzz')).toEqual(['a', 'b', 'c']);
  });
});

describe('moveWithinGroups', () => {
  const groups = [
    { sessions: [{ id: 'a' }, { id: 'b' }] },
    { sessions: [{ id: 'c' }, { id: 'd' }] },
  ];

  it('reorders within a group over the flattened visible order', () => {
    expect(moveWithinGroups(groups, 'd', 'c')).toEqual(['a', 'b', 'd', 'c']);
    expect(moveWithinGroups(groups, 'b', 'a')).toEqual(['b', 'a', 'c', 'd']);
  });

  it('refuses a drag across groups (a session never changes project)', () => {
    expect(moveWithinGroups(groups, 'a', 'c')).toBeNull();
  });

  it('refuses when either id is missing or the ids match', () => {
    expect(moveWithinGroups(groups, 'zzz', 'a')).toBeNull();
    expect(moveWithinGroups(groups, 'a', 'zzz')).toBeNull();
    expect(moveWithinGroups(groups, 'a', 'a')).toBeNull();
  });

  it('returns null when the move changes nothing (dragover fires continuously)', () => {
    // a already sits immediately before b — re-dropping it there is a no-op.
    expect(moveWithinGroups(groups, 'a', 'b')).toBeNull();
  });
});

describe('mergeOrder', () => {
  it('keeps unseen stored ids after the visible ones, in stored order', () => {
    expect(mergeOrder(['b', 'a'], ['a', 'x', 'b', 'y'])).toEqual(['b', 'a', 'x', 'y']);
  });

  it('drops nothing and dedupes nothing that is not duplicated', () => {
    expect(mergeOrder(['a'], [])).toEqual(['a']);
    expect(mergeOrder([], ['x', 'y'])).toEqual(['x', 'y']);
  });
});
