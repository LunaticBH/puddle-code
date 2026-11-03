import { useCallback, useState, useSyncExternalStore } from 'react';
import { Circle, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Button } from '../../../components/ui/button';
import { deleteDraft } from '../../../lib/persistence/drafts';
import { bufferKey, isDirty, subscribe } from '../buffers/buffer-store';
import { announceDraftDiscarded } from '../buffers/editor-sync';
import type { EditorTabKind } from './editor-tabs';

/** Reactive dirty flag for one (session, path[, root]) buffer. */
function useDirty(session: string, path: string, root?: string): boolean {
  const key = bufferKey(session, path, root);
  return useSyncExternalStore(
    useCallback((cb: () => void) => subscribe(key, cb), [key]),
    () => isDirty(key),
  );
}

/**
 * The IN-FLOW dirty marker after a tab chip's filename (SPEC §12): it takes
 * real width — widening the chip up to its cap, the filename truncating past
 * it — instead of sitting over the title. Hidden on hover, where the overlay
 * close × takes its place. Lives behind the lazy editor chunk like the close
 * control below.
 */
export function EditorDirtyDot({
  session,
  path,
  kind,
  root,
}: {
  session: string;
  path: string;
  kind: EditorTabKind;
  /** Absolute browse root of an `external` tab (SPEC §8). */
  root?: string;
}) {
  const dirty = useDirty(session, path, root) && kind !== 'commit';
  if (!dirty) return null;
  return (
    <Circle aria-hidden className="size-2 shrink-0 fill-current text-fg-muted group-hover:hidden" />
  );
}

/**
 * The close control for an editor tab in a tiling pane (SPEC §8): a hover ×
 * (the resting dirty state is `EditorDirtyDot`, in flow after the filename)
 * and a discard-confirm when closing an unsaved file. Lives behind the lazy
 * editor chunk (it reads `buffer-store` → Monaco); the strip renders it under
 * Suspense so a terminal-only workspace never loads Monaco. `commit` tabs are
 * read-only and never dirty.
 */
export function EditorTabClose({
  session,
  path,
  kind,
  root,
  label,
  onClose,
}: {
  session: string;
  path: string;
  kind: EditorTabKind;
  /** Absolute browse root of an `external` tab (SPEC §8). */
  root?: string;
  label: string;
  onClose: () => void;
}) {
  const dirty = useDirty(session, path, root) && kind !== 'commit';
  const [confirm, setConfirm] = useState(false);

  const requestClose = () => (dirty ? setConfirm(true) : onClose());
  const discard = () => {
    void deleteDraft(session, path, root);
    announceDraftDiscarded(session, path, root);
    setConfirm(false);
    onClose();
  };

  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          requestClose();
        }}
        // Reveal by display, not opacity, so a tab's close reserves no width
        // at rest (HUMANS.md). The resting dirty dot is EditorDirtyDot, in
        // flow after the filename — never over it — so this is purely the
        // hover ×.
        className="hidden size-4 items-center justify-center rounded-sm text-fg-muted transition-colors hover:text-fg group-hover:flex pointer-coarse:flex"
        aria-label={`Close ${label}`}
      >
        <X className="size-3" />
      </button>
      <Dialog open={confirm} onOpenChange={(open) => !open && setConfirm(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes to {label}?</DialogTitle>
            <DialogDescription>
              This file has unsaved changes. Closing the tab will discard them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={discard}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
