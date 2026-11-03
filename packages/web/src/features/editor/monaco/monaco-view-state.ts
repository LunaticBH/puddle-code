import { useCallback, useLayoutEffect, useRef } from 'react';
import type { editor } from 'monaco-editor';
import { useViewStateKey } from '../tabs/view-state-context';
import { ViewStateStore } from '../tabs/view-state-store';

const codeStates = new ViewStateStore<editor.ICodeEditorViewState>();
const diffStates = new ViewStateStore<editor.IDiffEditorViewState>();

function durableCodeState(state: editor.ICodeEditorViewState): editor.ICodeEditorViewState {
  const contributionsState = { ...state.contributionsState };
  // Occurrence highlights are recomputed from the cursor. Restoring Monaco
  // 0.55's pending highlighter work cancels a live promise without handling
  // its rejection; retain folds and other durable contributions instead.
  delete contributionsState['editor.contrib.wordHighlighter'];
  return { ...state, contributionsState };
}

/** Save before React's passive model/editor disposal, even for private diff models. */
function useBinding<E extends editor.ICodeEditor | editor.IDiffEditor>(
  key: string,
  bind: (editor: E, key: string) => () => void,
) {
  const instance = useRef<E | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (instance.current) cleanup.current = bind(instance.current, key);
    return () => {
      cleanup.current?.();
      cleanup.current = null;
    };
  }, [key, bind]);
  return useCallback(
    (editor: E) => {
      cleanup.current?.();
      instance.current = editor;
      editor.onDidDispose(() => {
        if (instance.current === editor) instance.current = null;
      });
      cleanup.current = bind(editor, key);
    },
    [key, bind],
  );
}

function bindCode(editor: editor.IStandaloneCodeEditor, key: string): () => void {
  const saved = codeStates.get(key);
  if (saved) editor.restoreViewState(saved);
  const capture = () => {
    if (!editor.getModel()) return;
    const state = editor.saveViewState();
    if (state) codeStates.set(key, durableCodeState(state));
  };
  const subscriptions = [
    editor.onDidScrollChange(capture),
    editor.onDidChangeCursorSelection(capture),
  ];
  return () => {
    capture();
    subscriptions.forEach((subscription) => subscription.dispose());
  };
}

function bindDiff(editor: editor.IStandaloneDiffEditor, key: string): () => void {
  const saved = diffStates.get(key);
  let awaitingDiff = saved !== undefined;
  const capture = () => {
    if (awaitingDiff || !editor.getModel()) return;
    const state = editor.saveViewState();
    if (state)
      diffStates.set(key, {
        ...state,
        original: state.original && durableCodeState(state.original),
        modified: state.modified && durableCodeState(state.modified),
      });
  };
  if (saved) editor.restoreViewState(saved);
  const subscriptions = [
    editor.onDidUpdateDiff(() => {
      if (!awaitingDiff) return;
      awaitingDiff = false;
      if (saved) editor.restoreViewState(saved);
    }),
    ...[editor.getOriginalEditor(), editor.getModifiedEditor()].flatMap((side) => [
      side.onDidScrollChange(capture),
      side.onDidChangeCursorSelection(capture),
    ]),
  ];
  return () => {
    capture();
    subscriptions.forEach((subscription) => subscription.dispose());
  };
}

export function useCodeViewState(target: unknown) {
  return useBinding(useViewStateKey('code', target), bindCode);
}

export function useDiffViewState(target: unknown) {
  return useBinding(useViewStateKey('diff', target), bindDiff);
}
