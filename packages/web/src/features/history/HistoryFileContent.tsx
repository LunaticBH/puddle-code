import { useEffect, useMemo, useRef } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type { DiffEntry } from '@puddle/shared';
import { useClientSettings } from '../../lib/settings/client-settings';
import { useFileAt } from '../../lib/queries/worktree-queries';
import { ApiError } from '../../lib/transport/api';
import { DeletedContent, Note, ReadOnlyView, viewerUri } from '../diff/FileDiffContent';
import { monaco, THEME_NAME } from '../editor/monaco/monaco-setup';
import { editorIndentationOptions } from '../editor/monaco/monaco-options';
import { effectiveStatus } from './history-logic';
import { useDiffViewState } from '../editor/monaco/monaco-view-state';

/**
 * `added` (and the root-commit override, and a `sha^` original that 404s
 * unexpectedly — see `effectiveStatus`): the file's content at `sha`, plain
 * and read-only, no original side.
 */
function AddedAt({
  session,
  sha,
  path,
  root,
}: {
  session: string;
  sha: string;
  path: string;
  root?: string;
}) {
  const file = useFileAt(session, sha, path, { root });
  if (file.isPending) return <Note>…</Note>;
  if (file.error) {
    return <Note>{file.error instanceof Error ? file.error.message : 'Failed to load file'}</Note>;
  }
  if (file.data.binary) return <Note>Binary file</Note>;
  return (
    <ReadOnlyView
      session={session}
      refName={`${sha}:${root ?? ''}`}
      path={path}
      content={file.data.content ?? ''}
    />
  );
}

/**
 * A read-only Monaco diff between two fixed refs, wholly private models on
 * both sides — never the shared buffer-store, since a sha→sha comparison has
 * no notion of "the current editable draft" (SPEC §8, Task 9). Disposal
 * mirrors FileDiffContent's `ModifiedContent`: the DiffEditorWidget does not
 * auto-detach a disposed model (it logs a BugIndicatingError instead, per
 * that file's comment — monaco 0.55.1), so both `keepCurrent*Model` flags are
 * set and this component detaches (`setModel(null)`) before disposing either
 * model itself, rather than letting the library's own unmount path dispose a
 * still-attached model.
 */
function HistoryDiffEditor({
  session,
  originalRef,
  originalPath,
  originalContent,
  modifiedRef,
  modifiedPath,
  modifiedContent,
  root,
}: {
  session: string;
  originalRef: string;
  originalPath: string;
  originalContent: string;
  modifiedRef: string;
  modifiedPath: string;
  modifiedContent: string;
  root?: string;
}) {
  const settings = useClientSettings();
  const restoreView = useDiffViewState([
    session,
    root,
    originalRef,
    originalPath,
    modifiedRef,
    modifiedPath,
  ]);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const fontMono = useMemo(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      undefined,
    [],
  );

  useEffect(
    () => () => {
      const editor = editorRef.current;
      if (!editor) return;
      const models = editor.getModel();
      editor.setModel(null);
      models?.original.dispose();
      models?.modified.dispose();
      editorRef.current = null;
    },
    [],
  );

  return (
    <DiffEditor
      originalModelPath={viewerUri(
        'puddle-hist-orig',
        session,
        `${originalRef}:${root ?? ''}`,
        originalPath,
      )}
      modifiedModelPath={viewerUri(
        'puddle-hist-mod',
        session,
        `${modifiedRef}:${root ?? ''}`,
        modifiedPath,
      )}
      original={originalContent}
      modified={modifiedContent}
      theme={THEME_NAME}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      loading={<Note>…</Note>}
      onMount={(editor) => {
        restoreView(editor);
        editorRef.current = editor;
        // Cheap insurance mirroring ModifiedContent — see that file's comment.
        editor.onDidDispose(() => {
          editorRef.current = null;
        });
      }}
      options={{
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
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

/** `modified`/`renamed`: `sha^` (original) vs. `sha` (modified), both read-only. */
function ModifiedAt({
  session,
  sha,
  path,
  basePath,
  root,
}: {
  session: string;
  sha: string;
  path: string;
  basePath: string;
  root?: string;
}) {
  const original = useFileAt(session, `${sha}^`, basePath, { root });
  const modified = useFileAt(session, sha, path, { root });

  // Tolerated per the brief even though `effectiveStatus` already keeps a
  // root commit out of this branch: an unexpected 404 on the parent blob
  // degrades to an added-only view instead of an error.
  const originalMissing = original.error instanceof ApiError && original.error.status === 404;
  if (originalMissing) return <AddedAt session={session} sha={sha} path={path} root={root} />;

  if (original.isPending || modified.isPending) return <Note>…</Note>;
  if (original.error) {
    return (
      <Note>
        {original.error instanceof Error ? original.error.message : 'Failed to load original'}
      </Note>
    );
  }
  if (modified.error) {
    return (
      <Note>
        {modified.error instanceof Error ? modified.error.message : 'Failed to load file'}
      </Note>
    );
  }
  if (original.data.binary || modified.data.binary) return <Note>Binary file</Note>;

  return (
    <HistoryDiffEditor
      session={session}
      originalRef={`${sha}^`}
      originalPath={basePath}
      originalContent={original.data.content ?? ''}
      modifiedRef={sha}
      modifiedPath={path}
      modifiedContent={modified.data.content ?? ''}
      root={root}
    />
  );
}

/**
 * The Monaco body for one file in a commit's `show` (SPEC §8): `sha^`→`sha`,
 * read-only, chosen by status. `CommitTabBody` renders it as a centre-editor
 * commit tab; its hooks and Monaco mount only while that tab is active.
 */
export function HistoryFileContent({
  session,
  sha,
  entry,
  isRootCommit,
  root,
}: {
  session: string;
  sha: string;
  entry: DiffEntry;
  isRootCommit: boolean;
  root?: string;
}) {
  switch (effectiveStatus(entry.status, isRootCommit)) {
    case 'added':
      return <AddedAt session={session} sha={sha} path={entry.path} root={root} />;
    case 'deleted':
      return <DeletedContent session={session} against={`${sha}^`} path={entry.path} root={root} />;
    case 'modified':
    case 'renamed':
      return (
        <ModifiedAt
          session={session}
          sha={sha}
          path={entry.path}
          basePath={entry.old_path ?? entry.path}
          root={root}
        />
      );
    default:
      return null;
  }
}
