import { hasComparisonContent } from './conflict-store';
import { ConflictView } from './ConflictView';
import type { EditorBuffer } from '../buffers/use-editor-buffer';

/**
 * The locked half of stale-save reconciliation, shared by every surface that
 * can hold an editable buffer. It deliberately consumes an existing
 * `useEditorBuffer` result instead of mounting a second holder: a nested hook
 * would overwrite the buffer's save-registry entry and remove it again when
 * the comparison resolved.
 */
export function ConflictSurface({
  session,
  path,
  buffer,
  focused,
}: {
  session: string;
  path: string;
  buffer: EditorBuffer;
  /** Only the comparison the user asked for may release the shared lock. */
  focused: boolean;
}) {
  const conflict = buffer.conflict;
  if (!conflict || conflict.phase === 'unresolved') return null;

  if (hasComparisonContent(conflict) && buffer.model) {
    return (
      <ConflictView
        session={session}
        path={path}
        conflict={conflict}
        model={buffer.model}
        onTakeDisk={buffer.takeDisk}
        onKeepMine={buffer.keepMine}
        onSave={buffer.save}
        onReady={focused ? buffer.comparisonReady : undefined}
      />
    );
  }

  if (conflict.phase === 'load-error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-ground px-4 text-center text-sm text-fg-muted">
        <span>The disk version could not be loaded.</span>
        <span className="max-w-lg text-xs text-fg-secondary">{conflict.message}</span>
        <button
          type="button"
          onClick={buffer.compare}
          className="rounded-md bg-elevated px-3 py-1.5 text-xs text-fg-secondary transition-colors hover:bg-border hover:text-fg"
        >
          Retry compare
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-ground text-sm text-fg-muted">
      Loading the disk version…
    </div>
  );
}
