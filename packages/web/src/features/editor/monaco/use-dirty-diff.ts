import { useCallback, useEffect, useState } from 'react';
import { useDaemonVersion } from '../../../lib/queries/queries';
import { sourceControlSupported } from '../../../lib/transport/protocol-support';
import { useGitOriginal } from '../../../lib/queries/worktree-queries';
import { dirtyDecorations, type DirtyDecorationKind } from './dirty-diff';
import { createDirtyDiffPeekController } from './dirty-diff-peek';
import { monaco } from './monaco-setup';

const CLASS_NAME: Record<DirtyDecorationKind, string> = {
  added: 'puddle-dirty-added',
  modified: 'puddle-dirty-modified',
  'deleted-before': 'puddle-dirty-deleted-before',
  'deleted-after': 'puddle-dirty-deleted-after',
};

/**
 * Own the hidden Monaco diff controller behind one ordinary editor. The
 * modified side is the editor's live shared model, so typing and undo/redo
 * automatically schedule Monaco's worker and refresh the decoration set.
 */
export function useDirtyDiff(
  session: string,
  path: string,
  root: string | undefined,
  model: monaco.editor.ITextModel | null,
): (editor: monaco.editor.IStandaloneCodeEditor) => void {
  const version = useDaemonVersion();
  const supported = version.data !== undefined && sourceControlSupported(version.data.protocol);
  const baseline = useGitOriginal(session, path, { root, enabled: supported && model !== null });
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);

  const mount = useCallback((mounted: monaco.editor.IStandaloneCodeEditor) => {
    setEditor(mounted);
  }, []);

  useEffect(() => {
    const data = baseline.data;
    if (!editor || !model || !data || data.repository === null || data.ignored || data.binary) {
      return;
    }

    const host = document.createElement('div');
    host.className = 'puddle-hidden-diff-controller';
    document.body.appendChild(host);
    const original = monaco.editor.createModel(
      data.exists ? (data.content ?? '') : '',
      model.getLanguageId(),
    );
    const controller = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      automaticLayout: false,
      renderSideBySide: false,
      minimap: { enabled: false },
    });
    const collection = editor.createDecorationsCollection();
    controller.setModel({ original, modified: model });
    const peek = createDirtyDiffPeekController({ editor, original, modified: model, path });

    const update = () => {
      const changes = controller.getLineChanges();
      if (!changes) return;
      peek.update(changes);
      collection.set(
        dirtyDecorations(changes, model.getLineCount()).map((decoration) => ({
          range: new monaco.Range(decoration.startLineNumber, 1, decoration.endLineNumber, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: CLASS_NAME[decoration.kind],
          },
        })),
      );
    };
    const diffListener = controller.onDidUpdateDiff(update);
    update();
    return () => {
      diffListener.dispose();
      peek.dispose();
      collection.clear();
      controller.setModel(null);
      controller.dispose();
      original.dispose();
      host.remove();
    };
  }, [editor, model, baseline.data]);

  return mount;
}
