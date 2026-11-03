import { useEffect, useRef } from 'react';
import { bufferKey, releaseModel, retainModel } from './buffer-store';

/** A (session, path[, root]) triple whose shared editor model should be kept alive. */
export interface HeldBuffer {
  session: string;
  path: string;
  /** Absolute browse root of an `external` tab (SPEC §8). */
  root?: string;
}

/**
 * Keeps the shared Monaco models for the open editor tabs alive (SPEC §8),
 * lifted out of the old `EditorZone` so it can be driven by the WHOLE tiling
 * tree rather than one zone. A model is retained while ANY pane holds a file or
 * diff tab for its `(session, path)` and disposed only when the last one closes
 * — so an inactive tab (or the same file open in two panes) keeps its dirty
 * edits and undo history. `commit` tabs are excluded by the caller (they use
 * private models). Renders nothing; it exists for its retain/release effect.
 * Imported behind the lazy editor chunk so `buffer-store` (→ Monaco) stays split.
 */
export function ModelRefcount({ buffers }: { buffers: HeldBuffer[] }) {
  const held = useRef<Set<string>>(new Set());

  useEffect(() => {
    const want = new Set(buffers.map((b) => bufferKey(b.session, b.path, b.root)));
    const cur = held.current;
    for (const key of want) {
      if (!cur.has(key)) {
        retainModel(key);
        cur.add(key);
      }
    }
    for (const key of [...cur]) {
      if (!want.has(key)) {
        releaseModel(key);
        cur.delete(key);
      }
    }
  }, [buffers]);

  // Release everything still held when the tiling area unmounts.
  useEffect(
    () => () => {
      for (const key of held.current) releaseModel(key);
      held.current.clear();
    },
    [],
  );

  return null;
}
