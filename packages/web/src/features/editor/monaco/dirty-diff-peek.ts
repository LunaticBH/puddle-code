import {
  dirtyChangeAtLine,
  dirtyPeekAfterLine,
  dirtyPeekLineCount,
  type DirtyDecorationKind,
  type DirtyLineChange,
} from './dirty-diff';
import { monaco } from './monaco-setup';

const HEADER_HEIGHT_PX = 28;

const DECORATION_KIND_BY_CLASS: ReadonlyArray<readonly [string, DirtyDecorationKind]> = [
  ['puddle-dirty-added', 'added'],
  ['puddle-dirty-modified', 'modified'],
  ['puddle-dirty-deleted-before', 'deleted-before'],
  ['puddle-dirty-deleted-after', 'deleted-after'],
];

function clickedDecorationKind(element: HTMLElement | null): DirtyDecorationKind | undefined {
  if (!element) return undefined;
  for (const [className, kind] of DECORATION_KIND_BY_CLASS) {
    if (element.classList.contains(className) || element.closest(`.${className}`)) return kind;
  }
  return undefined;
}

interface OpenPeek {
  anchorLine: number;
  change: DirtyLineChange;
  zone: monaco.editor.IViewZone;
  zoneId: string;
  frame: number | null;
  diffEditor: monaco.editor.IStandaloneDiffEditor | null;
}

export interface DirtyDiffPeekController {
  /** Refresh the clickable hunks after Monaco's hidden diff recomputes. */
  update(changes: readonly DirtyLineChange[]): void;
  dispose(): void;
}

/**
 * Add VS Code-style, read-only hunk peeks to one ordinary source editor using
 * Monaco's public gutter mouse targets, view zones, and standalone diff editor.
 * The visible source model and existing HEAD model are shared, never copied or
 * owned here; disposing a peek only detaches its widget.
 */
export function createDirtyDiffPeekController({
  editor,
  original,
  modified,
  path,
}: {
  editor: monaco.editor.IStandaloneCodeEditor;
  original: monaco.editor.ITextModel;
  modified: monaco.editor.ITextModel;
  path: string;
}): DirtyDiffPeekController {
  let changes: readonly DirtyLineChange[] = [];
  let peek: OpenPeek | null = null;
  let disposed = false;

  const removeZone = (zoneId: string) => {
    // The parent editor may have started disposal before React tears this hook
    // down. Its view-zone accessor is then unavailable, but the DOM is already
    // going away, so only the nested widget still needs explicit disposal.
    try {
      editor.changeViewZones((accessor) => accessor.removeZone(zoneId));
    } catch {
      // Parent disposal owns the zone from here.
    }
  };

  const close = () => {
    const current = peek;
    if (!current) return;
    peek = null;
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    if (current.diffEditor) {
      current.diffEditor.setModel(null);
      current.diffEditor.dispose();
    }
    removeZone(current.zoneId);
  };

  const reveal = (current: OpenPeek) => {
    const nested = current.diffEditor;
    if (!nested) return;
    const target = Math.max(
      1,
      Math.min(modified.getLineCount(), current.change.modifiedStartLineNumber),
    );
    nested.getModifiedEditor().revealLineInCenter(target, monaco.editor.ScrollType.Immediate);
  };

  const open = (lineNumber: number, change: DirtyLineChange) => {
    if (peek?.anchorLine === lineNumber) {
      close();
      return;
    }
    close();

    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const domNode = document.createElement('div');
    domNode.className = 'puddle-dirty-peek';
    const header = document.createElement('div');
    header.className = 'puddle-dirty-peek-header';
    const title = document.createElement('span');
    title.className = 'puddle-dirty-peek-title';
    title.textContent = `${path.split('/').pop() ?? path} · Local changes against HEAD`;
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'puddle-dirty-peek-close';
    closeButton.setAttribute('aria-label', 'Close inline change');
    closeButton.title = 'Close inline change';
    closeButton.textContent = '×';
    // Monaco owns pointer handling for the whole view-zone layer. Closing on
    // pointerdown keeps its outer editor from consuming the press before the
    // browser can synthesise a click; click remains the keyboard fallback.
    closeButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      close();
    });
    closeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      close();
    });
    const diffHost = document.createElement('div');
    diffHost.className = 'puddle-dirty-peek-editor';
    header.append(title, closeButton);
    domNode.append(header, diffHost);

    const marginDomNode = document.createElement('div');
    marginDomNode.className = 'puddle-dirty-peek-margin';
    const zone: monaco.editor.IViewZone = {
      afterLineNumber: dirtyPeekAfterLine(change, modified.getLineCount()),
      heightInPx: HEADER_HEIGHT_PX + dirtyPeekLineCount(change) * lineHeight,
      domNode,
      marginDomNode,
      suppressMouseDown: false,
    };
    let zoneId = '';
    editor.changeViewZones((accessor) => {
      zoneId = accessor.addZone(zone);
    });
    const current: OpenPeek = {
      anchorLine: lineNumber,
      change,
      zone,
      zoneId,
      frame: null,
      diffEditor: null,
    };
    peek = current;

    // A view-zone node is attached after changeViewZones returns. Waiting one
    // frame gives the nested editor real dimensions on its first layout.
    current.frame = requestAnimationFrame(() => {
      current.frame = null;
      if (disposed || peek !== current) return;
      const diffEditor = monaco.editor.createDiffEditor(diffHost, {
        readOnly: true,
        domReadOnly: true,
        originalEditable: false,
        renderSideBySide: false,
        renderMarginRevertIcon: false,
        renderOverviewRuler: false,
        enableSplitViewResizing: false,
        isInEmbeddedEditor: true,
        automaticLayout: true,
        fontFamily: editor.getOption(monaco.editor.EditorOption.fontFamily),
        fontSize: editor.getOption(monaco.editor.EditorOption.fontSize),
        lineHeight,
        minimap: { enabled: false },
        glyphMargin: false,
        folding: false,
        scrollBeyondLastLine: false,
        fixedOverflowWidgets: true,
        hideUnchangedRegions: {
          enabled: true,
          minimumLineCount: 0,
          contextLineCount: 2,
          revealLineCount: 3,
        },
      });
      current.diffEditor = diffEditor;
      diffEditor.setModel({ original, modified });
      diffEditor.onDidUpdateDiff(() => reveal(current));
      reveal(current);
    });
    editor.revealLineInCenter(
      Math.max(1, Math.min(modified.getLineCount(), change.modifiedStartLineNumber)),
    );
  };

  const mouseListener = editor.onMouseDown((event) => {
    if (
      !event.event.leftButton ||
      event.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS ||
      event.target.position === null
    ) {
      return;
    }
    const lineNumber = event.target.position.lineNumber;
    const change = dirtyChangeAtLine(
      changes,
      lineNumber,
      modified.getLineCount(),
      clickedDecorationKind(event.target.element),
    );
    if (!change) return;
    event.event.preventDefault();
    event.event.stopPropagation();
    open(lineNumber, change);
  });

  return {
    update(next) {
      changes = next;
      if (!peek) return;
      const current = peek;
      const change = dirtyChangeAtLine(next, current.anchorLine, modified.getLineCount());
      if (!change) {
        close();
        return;
      }
      current.change = change;
      current.zone.afterLineNumber = dirtyPeekAfterLine(change, modified.getLineCount());
      current.zone.heightInPx =
        HEADER_HEIGHT_PX +
        dirtyPeekLineCount(change) * editor.getOption(monaco.editor.EditorOption.lineHeight);
      try {
        editor.changeViewZones((accessor) => accessor.layoutZone(current.zoneId));
      } catch {
        close();
        return;
      }
      reveal(current);
    },
    dispose() {
      disposed = true;
      mouseListener.dispose();
      close();
    },
  };
}
