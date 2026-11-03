import { describe, expect, it } from 'vitest';
import { paneInteractionIntent } from '../../../src/features/workspace/panes/pane-interaction';

describe('pane interaction routing', () => {
  it('lets locked-render scrolling drive scroll without taking logical focus', () => {
    expect(paneInteractionIntent('scroll', true, 'locked')).toEqual({
      focus: false,
      driveScroll: true,
    });
  });

  it('keeps presses as the gesture that focuses a pane', () => {
    expect(paneInteractionIntent('press', true, 'source')).toEqual({
      focus: true,
      driveScroll: true,
    });
  });

  it('does not make linked or non-renderable surfaces scroll drivers', () => {
    expect(paneInteractionIntent('scroll', true, 'linked')).toEqual({
      focus: false,
      driveScroll: false,
    });
    expect(paneInteractionIntent('scroll', false, 'source')).toEqual({
      focus: false,
      driveScroll: false,
    });
  });
});
