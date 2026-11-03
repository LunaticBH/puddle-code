import { beforeEach, describe, expect, it } from 'vitest';
import type { TabRef } from '@puddle/shared';
import {
  forgetClosedTabs,
  rememberClosedTab,
  takeClosedTab,
} from '../../../src/features/workspace/tabs/closed-tabs';

const term = (session: string): TabRef => ({ type: 'terminal', session });
const ed = (session: string, path: string): TabRef => ({ type: 'editor', tab: { session, path } });
const any = () => true;

beforeEach(forgetClosedTabs);

describe('closed-tabs', () => {
  it('reopens most-recent-first, remembering pane and position', () => {
    rememberClosedTab('profile', { leafId: 'L1', index: 2, ref: ed('s1', 'a.ts') });
    rememberClosedTab('profile', { leafId: 'L2', index: 0, ref: term('s1') });
    expect(takeClosedTab('profile', any)).toEqual({ leafId: 'L2', index: 0, ref: term('s1') });
    expect(takeClosedTab('profile', any)).toEqual({
      leafId: 'L1',
      index: 2,
      ref: ed('s1', 'a.ts'),
    });
    expect(takeClosedTab('profile', any)).toBeUndefined();
  });

  it('keeps each layout scope separate', () => {
    rememberClosedTab('profile', { leafId: 'L1', index: 0, ref: term('s1') });
    rememberClosedTab('project:aaaaaaaaaa', { leafId: 'L2', index: 0, ref: term('s2') });
    // a reopen in one scope never reaches into another's tree
    expect(takeClosedTab('project:bbbbbbbbbb', any)).toBeUndefined();
    expect(takeClosedTab('project:aaaaaaaaaa', any)?.ref).toEqual(term('s2'));
    expect(takeClosedTab('profile', any)?.ref).toEqual(term('s1'));
  });

  it('discards entries the caller rejects and keeps looking', () => {
    rememberClosedTab('profile', { leafId: 'L1', index: 0, ref: term('alive') });
    rememberClosedTab('profile', { leafId: 'L1', index: 1, ref: term('gone') });
    const usable = (ref: TabRef) => ref.type === 'terminal' && ref.session === 'alive';
    expect(takeClosedTab('profile', usable)?.ref).toEqual(term('alive'));
    // the rejected one is spent, not left behind to be offered again
    expect(takeClosedTab('profile', any)).toBeUndefined();
  });

  it('bounds the stack, dropping the oldest closures', () => {
    for (let i = 0; i < 25; i += 1) {
      rememberClosedTab('profile', { leafId: 'L1', index: i, ref: ed('s1', `f${i}.ts`) });
    }
    const seen: string[] = [];
    for (let entry = takeClosedTab('profile', any); entry; entry = takeClosedTab('profile', any)) {
      const { ref } = entry;
      if (ref.type === 'editor') seen.push(ref.tab.path);
    }
    expect(seen).toHaveLength(20);
    expect(seen[0]).toBe('f24.ts'); // newest first
    expect(seen.at(-1)).toBe('f5.ts'); // the first five fell off
  });
});
