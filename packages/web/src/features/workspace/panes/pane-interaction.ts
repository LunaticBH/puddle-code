import type { EditorView } from '../../editor/tabs/editor-tabs';

export interface PaneInteractionIntent {
  focus: boolean;
  driveScroll: boolean;
}

/**
 * Keep logical pane focus separate from locked-preview scroll ownership.
 * Pressing into a pane selects it; wheel/trackpad input only makes an eligible
 * renderable surface the proportional-scroll driver.
 */
export function paneInteractionIntent(
  kind: 'press' | 'scroll',
  renderable: boolean,
  view: EditorView,
): PaneInteractionIntent {
  return {
    focus: kind === 'press',
    driveScroll: renderable && view !== 'linked',
  };
}
