import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import type { DiffEntry, GitArea } from '@puddle/shared';
import { useClientSettings } from '../../lib/settings/client-settings';
import { useFileAt, useIndexFile } from '../../lib/queries/worktree-queries';
import { ApiError } from '../../lib/transport/api';
import { CodeEditor } from '../editor/monaco/CodeEditor';
import { ConflictSurface } from '../editor/conflicts/ConflictSurface';
import { bufferKey, releaseModel, retainModel } from '../editor/buffers/buffer-store';
import { monaco, THEME_NAME } from '../editor/monaco/monaco-setup';
import { editorIndentationOptions } from '../editor/monaco/monaco-options';
import { useEditorBuffer } from '../editor/buffers/use-editor-buffer';
import { useCodeViewState, useDiffViewState } from '../editor/monaco/monaco-view-state';

/**
 * A muted one-line note filling the section body (loading, binary, errors).
 * Exported: the history view (Task 9) reuses it verbatim for its own
 * loading/binary/error rows rather than redefining the same three lines.
 */
export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-xs text-fg-muted">
      {children}
    </div>
  );
}

/**
 * Retain the shared model for this key while the content is mounted and release
 * it on unmount (SPEC §8 refcount): the diff section is one holder, the editor
 * tab another, and the model is disposed only when the last lets go. Safe to
 * call before the model exists — the refcount is independent of the entry.
 *
 * Ordering matters: React 19 tears a deleted subtree down PARENT-FIRST
 * (react-dom 19.2.7 `commitPassiveUnmountEffectsInsideOfDeletedTree_begin`
 * runs hook cleanups on the way down), so this cleanup fires BEFORE any child
 * editor component's own unmount cleanup. If we are the last holder, the
 * release disposes the model while a child editor may still have it attached —
 * `detach` (when given) runs first to pull the model out of the editor. The
 * plain `<Editor>` path needs no detach: monaco 0.55.1's CodeEditorWidget
 * auto-detaches on `model.onWillDispose` (codeEditorWidget.js:1265); the
 * DiffEditorWidget does NOT (it logs a BugIndicatingError instead), hence
 * ModifiedContent's explicit detach.
 */
function useRetainedModel(key: string, detach?: () => void): void {
  const detachRef = useRef(detach);
  detachRef.current = detach;
  useEffect(() => {
    retainModel(key);
    return () => {
      detachRef.current?.();
      releaseModel(key);
    };
  }, [key]);
}

/**
 * A percent-encoded, uniquely-scheme'd URI for a throwaway read-only model.
 * Exported so every read-only viewer — this file's `ReadOnlyView`/
 * `DeletedContent`, and the history view's own private-model DiffEditor —
 * derives its model identity the same way, keeping "one model per (session,
 * ref, path)" a single rule rather than two copies that could drift.
 */
export function viewerUri(scheme: string, session: string, ref: string, path: string): string {
  const segments = path.split('/').map(encodeURIComponent).join('/');
  return `${scheme}://${encodeURIComponent(session)}/${encodeURIComponent(ref)}/${segments}`;
}

/**
 * Read-only Monaco viewer for content at a fixed ref (SPEC §8). Its own private
 * model (disposed on unmount via the default `keepCurrentModel: false`), never
 * a shared buffer — so history's sha→sha panes (Task 9) can reuse it as-is.
 */
export function ReadOnlyView({
  session,
  refName,
  path,
  content,
}: {
  session: string;
  refName: string;
  path: string;
  content: string;
}) {
  const settings = useClientSettings();
  const restoreView = useCodeViewState([session, refName, path]);
  const fontMono = useMemo(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      undefined,
    [],
  );
  return (
    <Editor
      path={viewerUri('puddle-view', session, refName, path)}
      defaultValue={content}
      theme={THEME_NAME}
      saveViewState={false}
      onMount={restoreView}
      loading={<Note>…</Note>}
      options={{
        readOnly: true,
        automaticLayout: true,
        fontFamily: fontMono,
        fontSize: settings.editorFontSize,
        ...editorIndentationOptions(settings.editorTabSize),
        minimap: { enabled: false },
        fixedOverflowWidgets: true,
        scrollBeyondLastLine: false,
      }}
    />
  );
}

/**
 * `deleted`: the base content, read-only, with a "Deleted" note. `against` is
 * just a ref string, so the history view (Task 9) reuses this unchanged for
 * a `sha^` original rather than a working-tree base — the read-only
 * semantics are identical either way.
 */
export function DeletedContent({
  session,
  against,
  path,
  root,
  indexBase = false,
}: {
  session: string;
  against: string;
  path: string;
  root?: string;
  indexBase?: boolean;
}) {
  const committed = useFileAt(session, against, path, { root, enabled: !indexBase });
  const indexed = useIndexFile(session, path, { root, enabled: indexBase });
  const base = indexBase ? indexed : committed;
  if (base.isPending) return <Note>…</Note>;
  if (base.error) {
    return <Note>{base.error instanceof Error ? base.error.message : 'Failed to load'}</Note>;
  }
  if (base.data.binary) return <Note>Binary file — deleted</Note>;
  return (
    <div className="flex h-full flex-col">
      <div className="bg-surface px-4 py-1 text-xs text-fg-muted">Deleted</div>
      <div className="min-h-0 flex-1">
        <ReadOnlyView
          session={session}
          refName={`${against}:${root ?? ''}`}
          path={path}
          content={base.data.content ?? ''}
        />
      </div>
    </div>
  );
}

/** `modified`/`renamed`: base (read-only) vs. the SHARED editor buffer. */
function ModifiedContent({
  session,
  against,
  path,
  basePath,
  root,
  indexBase = false,
  focused = true,
}: {
  session: string;
  against: string;
  path: string;
  basePath: string;
  root?: string;
  indexBase?: boolean;
  focused?: boolean;
}) {
  const settings = useClientSettings();
  const restoreView = useDiffViewState([session, root, against, indexBase, path]);
  // NB: when the same file is also open as an editor tab, its useEditorBuffer
  // instance and this one BOTH persist a draft per keystroke. The writes are
  // idempotent (same key, same content, debounced) — merely duplicated — and
  // there is no clean focus-ownership seam today, so this is left as is.
  const buffer = useEditorBuffer(session, path, null, root, { focused });
  const committed = useFileAt(session, against, basePath, { root, enabled: !indexBase });
  const indexed = useIndexFile(session, basePath, { root, enabled: indexBase });
  const base = indexBase ? indexed : committed;

  // Detach-before-release (see useRetainedModel): pull both models out of the
  // diff editor, then dispose the private original-side model ourselves — the
  // wrapper's later cleanup sees getModel() === null and no-ops, so the
  // original would otherwise leak.
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  useRetainedModel(bufferKey(session, path, root), () => {
    const editor = diffEditorRef.current;
    if (!editor) return;
    const models = editor.getModel();
    editor.setModel(null);
    models?.original.dispose();
    diffEditorRef.current = null;
  });

  const saveRef = useRef(buffer.save);
  saveRef.current = buffer.save;

  const fontMono = useMemo(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      undefined,
    [],
  );

  // The base blob does not exist at the ref (`not_at_ref`): treat as a new file
  // and render it as a plain editable buffer, not a diff (SPEC §8).
  const baseMissing = base.error instanceof ApiError && base.error.status === 404;

  // Once Compare is chosen, every editable surface over the shared model must
  // yield to the conflict controller. CodeEditor owns loading/error/comparison;
  // leaving `unresolved` here keeps this ordinary diff editable until then.
  if (buffer.conflict && buffer.conflict.phase !== 'unresolved') {
    return <ConflictSurface session={session} path={path} buffer={buffer} focused={focused} />;
  }

  if (buffer.status === 'binary' || base.data?.binary) return <Note>Binary file</Note>;
  if (buffer.status === 'too-large') return <Note>File too large to show</Note>;
  if (buffer.status === 'error') return <Note>{buffer.errorMessage ?? 'Failed to load file'}</Note>;
  if (baseMissing || (indexBase && indexed.data && !indexed.data.exists)) {
    return <CodeEditor session={session} path={path} reveal={null} root={root} focused={focused} />;
  }
  if (base.isPending || !buffer.model) return <Note>…</Note>;
  if (base.error) {
    return <Note>{base.error instanceof Error ? base.error.message : 'Failed to load base'}</Note>;
  }

  return (
    <DiffEditor
      // Binding the modified side to the shared buffer's own URI makes the
      // wrapper reuse that exact model (its `getModel(uri) ?? create` finds it),
      // so edits and dirty state flow straight into the editor tab's buffer —
      // no separate model, no content wipe. keepCurrentModifiedModel stops the
      // wrapper disposing it on unmount; our refcount owns disposal instead
      // (with the detach in useRetainedModel running first — see above).
      modifiedModelPath={buffer.model.uri.toString()}
      originalModelPath={viewerUri('puddle-base', session, `${against}:${root ?? ''}`, basePath)}
      original={base.data.content ?? ''}
      language={buffer.model.getLanguageId()}
      theme={THEME_NAME}
      keepCurrentModifiedModel
      loading={<Note>…</Note>}
      onMount={(diffEditor) => {
        restoreView(diffEditor);
        diffEditorRef.current = diffEditor;
        // If the widget somehow disposes before our cleanup (it shouldn't —
        // parent-first ordering — but cheap insurance), drop the stale ref so
        // the detach never touches a disposed editor.
        diffEditor.onDidDispose(() => {
          diffEditorRef.current = null;
        });
        diffEditor
          .getModifiedEditor()
          .addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
      }}
      options={{
        readOnly: false,
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
  );
}

/** HEAD → index: both sides are snapshots, so staged content is read-only. */
function StagedContent({
  session,
  against,
  entry,
  root,
}: {
  session: string;
  against: string;
  entry: DiffEntry;
  root?: string;
}) {
  const settings = useClientSettings();
  const restoreView = useDiffViewState([session, root, against, 'staged', entry.path]);
  const basePath = entry.old_path ?? entry.path;
  const base = useFileAt(session, against, basePath, {
    root,
    enabled: entry.status !== 'added',
  });
  const indexed = useIndexFile(session, entry.path, {
    root,
    enabled: entry.status !== 'deleted',
  });
  const fontMono = useMemo(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      undefined,
    [],
  );

  if (entry.status === 'deleted') {
    return <DeletedContent session={session} against={against} path={basePath} root={root} />;
  }
  if (indexed.isPending || (entry.status !== 'added' && base.isPending)) return <Note>…</Note>;
  if (indexed.error || base.error) {
    const error = indexed.error ?? base.error;
    return <Note>{error instanceof Error ? error.message : 'Failed to load staged content'}</Note>;
  }
  if (indexed.data.binary || base.data?.binary) return <Note>Binary file</Note>;
  if (entry.status === 'added') {
    return (
      <ReadOnlyView
        session={session}
        refName={`index:${root ?? ''}`}
        path={entry.path}
        content={indexed.data.content ?? ''}
      />
    );
  }
  if (!base.data) return <Note>Failed to load HEAD content</Note>;
  return (
    <DiffEditor
      originalModelPath={viewerUri('puddle-head', session, `${against}:${root ?? ''}`, basePath)}
      modifiedModelPath={viewerUri('puddle-index', session, `${against}:${root ?? ''}`, entry.path)}
      original={base.data.content ?? ''}
      modified={indexed.data.content ?? ''}
      onMount={restoreView}
      theme={THEME_NAME}
      loading={<Note>…</Note>}
      options={{
        readOnly: true,
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
  );
}

/** `added` (and a base that 404s as `not_at_ref`): a plain editable buffer. */
function AddedContent({
  session,
  path,
  root,
  focused,
}: {
  session: string;
  path: string;
  root?: string;
  focused: boolean;
}) {
  useRetainedModel(bufferKey(session, path, root));
  // CodeEditor owns the shared buffer, save flow, and binary/too-large
  // fallbacks (SPEC §8: a new file renders as a plain editor, not a diff).
  return <CodeEditor session={session} path={path} reveal={null} root={root} focused={focused} />;
}

/**
 * The Monaco body for one diff entry, chosen by status (SPEC §8). `DiffTabBody`
 * renders it as a centre-editor diff tab; its hooks — and the shared-model
 * retain — run only while that tab is mounted. The modified side binds to the
 * file's shared editor buffer, so ⌘S here saves through the same path.
 */
export function FileDiffContent({
  session,
  against,
  entry,
  root,
  area,
  focused = true,
}: {
  session: string;
  against: string;
  entry: DiffEntry;
  /** `?root=` when the diff is against a directory target (12.4). */
  root?: string;
  area?: GitArea;
  focused?: boolean;
}) {
  if (area === 'staged') {
    return <StagedContent session={session} against={against} entry={entry} root={root} />;
  }
  switch (entry.status) {
    case 'added':
      return <AddedContent session={session} path={entry.path} root={root} focused={focused} />;
    case 'deleted':
      return (
        <DeletedContent
          session={session}
          against={against}
          path={entry.path}
          root={root}
          indexBase={area === 'unstaged'}
        />
      );
    case 'modified':
    case 'renamed':
      return (
        <ModifiedContent
          session={session}
          against={against}
          path={entry.path}
          basePath={entry.old_path ?? entry.path}
          root={root}
          indexBase={area === 'unstaged'}
          focused={focused}
        />
      );
    default:
      return null;
  }
}
