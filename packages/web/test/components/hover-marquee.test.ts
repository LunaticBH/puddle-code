import { describe, expect, it } from 'vitest';
import { marqueeDurationMs } from '../../src/components/hover-marquee';

/**
 * The whole point of deriving the duration is that every marquee in the app
 * travels at ONE speed: a fixed duration made a long path race past while a
 * barely-clipped one crawled, which is backwards for legibility.
 */
describe('marqueeDurationMs', () => {
  it('is proportional to the distance — one speed for every label', () => {
    const short = marqueeDurationMs(100);
    const long = marqueeDurationMs(400);
    expect(long / short).toBeCloseTo(4, 1);
    // px/ms is the same at both lengths, which is what "same speed" means.
    expect(100 / short).toBeCloseTo(400 / long, 4);
  });

  it('never drops below the floor, so a few clipped pixels still animate', () => {
    expect(marqueeDurationMs(1)).toBe(marqueeDurationMs(0));
    expect(marqueeDurationMs(1)).toBeGreaterThan(100);
  });

  it('keeps a legible pace: a long path takes seconds, not a blink', () => {
    // ~600px of tail is a deep repo path in a narrow sidebar.
    expect(marqueeDurationMs(600)).toBeGreaterThan(3000);
    expect(marqueeDurationMs(600)).toBeLessThan(12_000);
  });
});
