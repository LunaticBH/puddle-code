import type { Layout } from 'react-resizable-panels';

/**
 * Extracts one Group's `defaultLayout` from the workspace's single persisted
 * `layout` object (ui-state snapshot key `layout`).
 *
 * The workspace has TWO resizable Groups — the horizontal shell and the
 * vertical editor/session split nested in its main panel — whose panel ids
 * never collide, so both persist into one flat `{panelId: flexGrow}` object
 * (each `onLayoutChanged` merges its keys in). Restoring needs the inverse:
 * react-resizable-panels@4.12.2 applies a `defaultLayout` ONLY when its key
 * count equals the Group's panel count EXACTLY (dist source, the
 * `Object.keys(defaultLayout).length === panels.length` guard) — handing both
 * Groups the whole merged object means neither count ever matches and every
 * pane silently resets on reload.
 *
 * So each Group asks for exactly the ids of the panels it is rendering RIGHT
 * NOW — the caller includes conditional panels (explorer, editor) only when
 * present, which keeps the count correct in every configuration. Any id
 * missing from storage (fresh project, a snapshot from before that panel
 * existed, or a legacy shape) returns `undefined`: the Group falls back to
 * its `defaultSize`s — graceful degradation, never a crash.
 */
export function layoutForPanels(
  stored: Record<string, unknown>,
  panelIds: readonly string[],
): Layout | undefined {
  const picked: Layout = {};
  for (const id of panelIds) {
    const size = stored[id];
    if (typeof size !== 'number') return undefined;
    picked[id] = size;
  }
  return picked;
}
