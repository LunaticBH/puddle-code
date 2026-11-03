import { useEffect, useId, useMemo, useRef } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { useClientSettings } from '../../../lib/settings/client-settings';
import { monaco, THEME_NAME } from '../monaco/monaco-setup';
import { editorIndentationOptions } from '../monaco/monaco-options';
import type { ComparedDiskConflict } from './conflict-store';
import { useDiffViewState } from '../monaco/monaco-view-state';

/**
 * How a refused save is reconciled (SPEC §8). The daemon rejects a write whose
 * `expected_mtime_ms` no longer matches the file (409 `stale_file`) — almost
 * always because the agent edited the file while it was open here. Before this
 * the only answers offered were Reload (lose your edits) or Overwrite (lose the
 * agent's), which asks you to choose blind between two versions you cannot see.
 *
 * So the tab shows both: the file **on disk** on the left, read-only, and **your
 * buffer** on the right, still editable and still the shared model — so copying
 * a hunk across is an ordinary edit, and ⌘S then writes the reconciled result
 * (the save expects the disk mtime recorded in the conflict, so a merge lands
 * instead of colliding again). The two blunt answers stay, as buttons, for when
 * one side is simply right.
 *
 * The bar carries no border and the buttons shift fill on hover (HUMANS.md).
 */
export function ConflictView({
  session,
  path,
  conflict,
  model,
  onTakeDisk,
  onKeepMine,
  onSave,
  onReady,
}: {
  session: string;
  path: string;
  conflict: ComparedDiskConflict;
  /** The shared buffer — bound as the modified side, so edits are the real thing. */
  model: monaco.editor.ITextModel;
  onTakeDisk(): void;
  onKeepMine(): void;
  onSave(): void;
  onReady?(revision: number): void;
}) {
  const settings = useClientSettings();
  const restoreView = useDiffViewState(['conflict', model.uri.toString()]);
  const instanceId = useId();
  const fontMono = useMemo(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      undefined,
    [],
  );
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  // Detach before the widget goes: a DiffEditorWidget does NOT auto-detach on
  // `model.onWillDispose` the way a plain editor does (it logs a
  // BugIndicatingError instead), and the shared model may be disposed by the
  // tree-wide refcount as this tab closes. Pulling both models out first also
  // lets us dispose the private disk-side model, which nothing else owns.
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const detach = () => {
    const editor = diffRef.current;
    if (!editor) return;
    const models = editor.getModel();
    editor.setModel(null);
    models?.original.dispose();
    diffRef.current = null;
  };
  const detachRef = useRef(detach);
  detachRef.current = detach;
  useEffect(() => () => detachRef.current(), []);

  return (
    <div className="flex h-full flex-col bg-ground">
      <div className="flex items-center gap-3 bg-elevated px-3 py-1.5 text-xs text-fg-secondary">
        <span>
          This file changed on disk. Yours is on the right — merge what you want, then save.
        </span>
        <button
          type="button"
          onClick={onTakeDisk}
          className="ml-auto shrink-0 text-fg-muted transition-colors hover:text-fg"
        >
          Take the disk version
        </button>
        <button
          type="button"
          onClick={onKeepMine}
          disabled={conflict.phase !== 'comparing'}
          className="shrink-0 text-fg-muted transition-colors hover:text-fg"
        >
          Keep mine
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <DiffEditor
          // The modified side binds to the shared buffer's own URI, so the
          // wrapper reuses that exact model — edits and dirty state flow into
          // the file's one buffer (the diff tab does the same). The disk side is
          // keyed by its mtime, so a second collision gets a fresh model rather
          // than the previous disk content.
          modifiedModelPath={model.uri.toString()}
          originalModelPath={`puddle-disk://${encodeURIComponent(session)}/${conflict.mtimeMs}/${encodeURIComponent(instanceId)}/${path
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`}
          original={conflict.content}
          language={model.getLanguageId()}
          theme={THEME_NAME}
          keepCurrentModifiedModel
          loading={<div className="p-3 text-xs text-fg-muted">…</div>}
          onMount={(diffEditor) => {
            restoreView(diffEditor);
            diffRef.current = diffEditor;
            diffEditor.onDidDispose(() => {
              diffRef.current = null;
            });
            diffEditor
              .getModifiedEditor()
              .addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
            // `opening` removed every editable view before the disk request. Do
            // not unlock until this widget has both sides mounted and visible.
            onReady?.(conflict.revision);
          }}
          options={{
            readOnly: conflict.phase !== 'comparing',
            originalEditable: false,
            renderSideBySide: true,
            automaticLayout: true,
            fontFamily: fontMono,
            fontSize: settings.editorFontSize,
            ...editorIndentationOptions(settings.editorTabSize),
            wordWrap: settings.editorWordWrap ? 'on' : 'off',
            minimap: { enabled: false },
            fixedOverflowWidgets: true,
            scrollBeyondLastLine: false,
          }}
        />
      </div>
    </div>
  );
}
