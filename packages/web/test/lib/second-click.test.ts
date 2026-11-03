import { describe, expect, it } from 'vitest';
import { isSecondClick, SECOND_CLICK_WINDOW_MS } from '../../src/lib/second-click';

describe('isSecondClick', () => {
  it('requires a recent previous click on the SAME item', () => {
    expect(isSecondClick(null, 'a', 1000)).toBe(false);
    expect(isSecondClick({ id: 'b', at: 900 }, 'a', 1000)).toBe(false);
    expect(isSecondClick({ id: 'a', at: 900 }, 'a', 1000)).toBe(true);
  });

  it('expires exactly at the window', () => {
    expect(isSecondClick({ id: 'a', at: 0 }, 'a', SECOND_CLICK_WINDOW_MS)).toBe(false);
    expect(isSecondClick({ id: 'a', at: 1 }, 'a', SECOND_CLICK_WINDOW_MS)).toBe(true);
  });
});
