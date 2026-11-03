import type * as Monaco from 'monaco-editor';
import {
  createAnimationFramePublisher,
  normalisedScrollRatio,
  previewScrollStore,
  scrollTopForPosition,
  type PreviewScrollBinding,
  type PreviewScrollPosition,
} from './preview-scroll-store';

interface MonacoLineGeometry {
  getTopForLineNumber(lineNumber: number): number;
  getScrollHeight(): number;
  getModel(): Monaco.editor.ITextModel | null;
}

/** Monaco's line tops already include wrapping, folding and font geometry. */
export function sourceLineAtMonacoScrollTop(
  editor: MonacoLineGeometry,
  scrollTop: number,
): number | null {
  const lineCount = editor.getModel()?.getLineCount() ?? 0;
  if (lineCount === 0) return null;
  let low = 1;
  let high = lineCount;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (editor.getTopForLineNumber(middle) <= scrollTop) low = middle;
    else high = middle - 1;
  }
  const top = editor.getTopForLineNumber(low);
  const nextTop = low < lineCount ? editor.getTopForLineNumber(low + 1) : editor.getScrollHeight();
  if (nextTop <= top) return low;
  return low + Math.min(1, Math.max(0, (scrollTop - top) / (nextTop - top)));
}

export function monacoScrollTopForSourceLine(
  editor: MonacoLineGeometry,
  sourceLine: number,
): number | null {
  const lineCount = editor.getModel()?.getLineCount() ?? 0;
  if (lineCount === 0 || !Number.isFinite(sourceLine)) return null;
  const line = Math.min(lineCount + 1, Math.max(1, sourceLine));
  const lower = Math.floor(line);
  if (lower > lineCount) return editor.getScrollHeight();
  const upper = lower + 1;
  const lowerTop = editor.getTopForLineNumber(lower);
  const upperTop =
    upper <= lineCount ? editor.getTopForLineNumber(upper) : editor.getScrollHeight();
  return lowerTop + (line - lower) * (upperTop - lowerTop);
}

/**
 * Monaco counterpart of the DOM scroll binding. Source tabs receive positions
 * published by a focused locked preview (and a stale/non-renderable locked ref
 * can still fall back to a receiving source surface).
 */
export function bindMonacoPreviewScroll(
  editor: Monaco.editor.IStandaloneCodeEditor,
  binding: PreviewScrollBinding,
  immediateScrollType: Monaco.editor.ScrollType,
): () => void {
  if (binding.driver && binding.receiver) {
    throw new Error('a Monaco scroll surface cannot be both driver and receiver');
  }
  const store = binding.store ?? previewScrollStore;
  const disposables: Monaco.IDisposable[] = [];
  let current: PreviewScrollPosition | undefined;
  let unsubscribe: () => void = () => undefined;
  let frames: ReturnType<typeof createAnimationFramePublisher> | undefined;

  const viewportHeight = () => editor.getLayoutInfo().height;
  const apply = (position: PreviewScrollPosition) => {
    current = position;
    const semanticTop =
      position.ratio > 0 && position.ratio < 1 && position.sourceLine !== null
        ? monacoScrollTopForSourceLine(editor, position.sourceLine)
        : null;
    editor.setScrollTop(
      semanticTop ?? scrollTopForPosition(position, editor.getScrollHeight(), viewportHeight()),
      immediateScrollType,
    );
  };

  if (binding.receiver) {
    unsubscribe = store.subscribe(binding.channel, binding.target, apply);
    disposables.push(editor.onDidChangeModel(() => current && apply(current)));
    disposables.push(editor.onDidLayoutChange(() => current && apply(current)));
    disposables.push(editor.onDidContentSizeChange(() => current && apply(current)));
  } else if (binding.driver) {
    frames = createAnimationFramePublisher(() => {
      const ratio = normalisedScrollRatio(
        editor.getScrollTop(),
        editor.getScrollHeight(),
        viewportHeight(),
      );
      store.publish(
        binding.channel,
        binding.target,
        ratio,
        sourceLineAtMonacoScrollTop(editor, editor.getScrollTop()),
      );
    });
    disposables.push(editor.onDidScrollChange(frames.schedule));
    disposables.push(editor.onDidChangeModel(frames.schedule));
    disposables.push(editor.onDidChangeModelContent(frames.schedule));
    disposables.push(editor.onDidLayoutChange(frames.schedule));
    disposables.push(editor.onDidContentSizeChange(frames.schedule));
    frames.schedule();
  }

  return () => {
    unsubscribe();
    for (const disposable of disposables) disposable.dispose();
    frames?.dispose();
  };
}
