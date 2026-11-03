import { Suspense, lazy, type ComponentType } from 'react';
import type { EditorPosition, RevealTarget } from '../workspace/editor-context';
import type { LatexSynctexResponse } from '@puddle/shared';
import type { EditorTab, EditorTabKind } from './tabs/editor-tabs';
import type { HeldBuffer } from './buffers/ModelRefcount';

/**
 * Lazy wrappers for the tiling layout's Monaco-touching pieces (SPEC §8), so the
 * eager `TileTree`/`PaneLeaf`/`PaneTabStrip` chrome never pulls `buffer-store`
 * (→ Monaco) onto the startup bundle — a terminal-only workspace loads no editor
 * code. Each mirrors `LazyEditorPane`/`LazyTerminal`.
 *
 * `warmEditorChunk` loads the chunk ahead of mounting and flips the wrappers to
 * render their components DIRECTLY — no Suspense pass. The workspace calls it
 * before mounting a restored layout that contains editor tabs: a reload must
 * never suspend the whole tiling tree into "Loading editor…" fallbacks (the
 * reveal only reached the screen on the next render).
 */

type BodyProps = {
  onRunCompilation?: (executedCopy?: boolean) => void;
  compilationRunning?: boolean;
  tab: EditorTab;
  reveal: RevealTarget | null;
  focused: boolean;
  scrollDriver: boolean;
  scrollReceiver: boolean;
  scrollChannel: string;
  onRevealSource?: (position: EditorPosition) => void;
  onRevealCompiledSource?: (target: LatexSynctexResponse) => void;
};
type RefcountProps = { buffers: HeldBuffer[] };

let ReadyBody: ComponentType<BodyProps> | null = null;
let ReadyRefcount: ComponentType<RefcountProps> | null = null;

/** Load the editor chunk ahead of mounting (the workspace's restore gate). */
export async function warmEditorChunk(): Promise<void> {
  const [body, refcount] = await Promise.all([
    import('./PaneEditorBody'),
    import('./buffers/ModelRefcount'),
  ]);
  ReadyBody = body.PaneEditorBody;
  ReadyRefcount = refcount.ModelRefcount;
}

const BodyInner = lazy(() =>
  import('./PaneEditorBody').then((m) => ({ default: m.PaneEditorBody })),
);
export function LazyPaneEditorBody(props: BodyProps) {
  if (ReadyBody) return <ReadyBody {...props} />;
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-ground text-xs text-fg-muted">
          Loading editor…
        </div>
      }
    >
      <BodyInner {...props} />
    </Suspense>
  );
}

const RefcountInner = lazy(() =>
  import('./buffers/ModelRefcount').then((m) => ({ default: m.ModelRefcount })),
);
export function LazyModelRefcount({ buffers }: { buffers: HeldBuffer[] }) {
  if (ReadyRefcount) return <ReadyRefcount buffers={buffers} />;
  return (
    <Suspense fallback={null}>
      <RefcountInner buffers={buffers} />
    </Suspense>
  );
}

const DirtyDotInner = lazy(() =>
  import('./tabs/EditorTabClose').then((m) => ({ default: m.EditorDirtyDot })),
);
/** The in-flow dirty dot after a chip's filename; nothing until the chunk lands. */
export function LazyEditorDirtyDot(props: {
  session: string;
  path: string;
  kind: EditorTabKind;
  root?: string;
}) {
  return (
    <Suspense fallback={null}>
      <DirtyDotInner {...props} />
    </Suspense>
  );
}

const CloseInner = lazy(() =>
  import('./tabs/EditorTabClose').then((m) => ({ default: m.EditorTabClose })),
);
export function LazyEditorTabClose(props: {
  session: string;
  path: string;
  kind: EditorTabKind;
  /** Absolute browse root of an `external` tab (SPEC §8). */
  root?: string;
  label: string;
  onClose: () => void;
}) {
  // Fallback: a plain close × (no dirty awareness) until the chunk lands.
  return (
    <Suspense
      fallback={
        <button
          onClick={(e) => {
            e.stopPropagation();
            props.onClose();
          }}
          className="hidden size-4 items-center justify-center rounded-sm text-fg-muted transition-colors hover:text-fg group-hover:flex pointer-coarse:flex"
          aria-label={`Close ${props.label}`}
        >
          ×
        </button>
      }
    >
      <CloseInner {...props} />
    </Suspense>
  );
}
