/**
 * Per-Group layout extraction from the single persisted `layout` object (see
 * `panel-layout.ts`): react-resizable-panels applies a `defaultLayout` only
 * when its key count exactly matches the Group's panel count, so each Group
 * must receive precisely its own panels' entries — including conditional
 * panels only when they are rendered — or fall back to defaults.
 */
import { describe, expect, it } from 'vitest';
import { layoutForPanels } from '../../../src/features/workspace/layout/panel-layout';

// A merged store as both Groups would leave it: horizontal (3) + vertical (2).
const merged = { sidebar: 260, explorer: 240, main: 900, editor: 360, session: 400 };

describe('layoutForPanels', () => {
  it('picks exactly the requested panel ids (horizontal, explorer open)', () => {
    expect(layoutForPanels(merged, ['sidebar', 'explorer', 'main'])).toEqual({
      sidebar: 260,
      explorer: 240,
      main: 900,
    });
  });

  it('omits a conditional panel that is not rendered (horizontal, explorer closed)', () => {
    expect(layoutForPanels(merged, ['sidebar', 'main'])).toEqual({ sidebar: 260, main: 900 });
  });

  it('extracts the nested vertical split without the horizontal keys', () => {
    expect(layoutForPanels(merged, ['editor', 'session'])).toEqual({ editor: 360, session: 400 });
  });

  it('returns undefined when a requested panel was never persisted (defaults apply)', () => {
    const legacy = { sidebar: 260, explorer: 240, main: 900 }; // pre-editor snapshot
    expect(layoutForPanels(legacy, ['editor', 'session'])).toBeUndefined();
  });

  it('returns undefined for an empty store (fresh project)', () => {
    expect(layoutForPanels({}, ['sidebar', 'main'])).toBeUndefined();
  });

  it('rejects non-numeric junk in a loose snapshot rather than passing it through', () => {
    expect(layoutForPanels({ sidebar: '260', main: 900 }, ['sidebar', 'main'])).toBeUndefined();
  });
});
