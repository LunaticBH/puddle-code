import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useClientSettings } from '../../lib/settings/client-settings';
import { DraftingCursor } from './DraftingCursor';
import { InvertCursor } from './InvertCursor';
import { RangefinderCursor } from './RangefinderCursor';

/** Mounts the renderer owned by the selected cursor package. */
export function CursorHost() {
  const { cursorPackage } = useClientSettings();
  let cursor: ReactNode = null;
  switch (cursorPackage) {
    case 'rangefinder':
      cursor = <RangefinderCursor />;
      break;
    case 'drafting':
      cursor = <DraftingCursor />;
      break;
    case 'invert':
      cursor = <InvertCursor />;
      break;
    case 'system':
      return null;
  }
  // Radix dialogs (including the command palette) portal directly under body.
  // Keep the visual cursor in that same top-level stacking context so their
  // full-screen overlays never expose the hidden native pointer at the sides.
  return createPortal(cursor, document.body);
}
