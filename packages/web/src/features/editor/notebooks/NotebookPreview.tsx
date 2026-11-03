import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { savedCellExecution } from './notebook-execution-results';
import { notebookActions } from './notebook-actions';
import { notebookClipboard } from './notebook-clipboard';
import { NotebookSearch, type NotebookMatch } from './NotebookSearch';
import { Plus } from 'lucide-react';
import { requestSave, saverKey } from '../buffers/save-registry';
import { useNotebookExecution } from './use-notebook-execution';
import { NotebookRenderingContext } from './NotebookRenderingContext';
import { NotebookToolbar } from './NotebookToolbar';
import { NotebookCell, notebookControl } from './NotebookCell';
import {
  parseNotebook,
  notebookCellIds,
  notebookText,
  notebookOutline,
  notebookSectionRange,
  newNotebookCell,
  replaceCellSource,
  changeNotebookCellLanguage,
  type Notebook,
} from './notebook-format';
import type { TextPreviewProps } from '../previews/preview-controls';
import { bindScrollRestoration } from '../previews/scroll-restoration';
import { WidgetContext, useNotebookWidgets } from './widgets/context';
import { useViewStateKey } from '../tabs/view-state-context';

/** Notebook edits share the source model's drafts, save path and conflict handling. */
export function NotebookPreview({
  text,
  session,
  path,
  root,
  onChange,
  onRun,
  running,
  onUndo,
  onRedo,
  onOpenFile,
  focused = true,
}: TextPreviewProps & {
  onChange?: (text: string) => void;
  onRun?: () => void;
  running?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}) {
  const parsed = useMemo(() => {
    try {
      return { notebook: notebookCellIds(parseNotebook(text)), error: null };
    } catch (error) {
      return { notebook: null, error: error instanceof Error ? error.message : 'Invalid notebook' };
    }
  }, [text]);
  const [folded, setFolded] = useState<string[]>([]);
  const [match, setMatch] = useState<NotebookMatch | null>(null);
  const revealFocus = useRef(true);
  const [active, setActive] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const selectionAnchor = useRef<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const reveal = useRef<string | null>(null);
  const viewKey = useViewStateKey('notebook', [session, root, path]);
  const ready = parsed.notebook !== null;
  useLayoutEffect(() => {
    if (!scroller.current || !content.current || !ready) return;
    const binding = bindScrollRestoration(scroller.current, content.current, viewKey);
    return () => binding.dispose();
  }, [viewKey, ready]);
  useLayoutEffect(() => {
    if (!reveal.current) return;
    const cell = content.current?.querySelector<HTMLElement>(
      `[data-cell-id="${CSS.escape(reveal.current)}"]`,
    );
    if (cell) {
      cell.scrollIntoView({ block: 'nearest' });
      if (revealFocus.current) cell.focus({ preventScroll: true });
      revealFocus.current = true;
      reveal.current = null;
    }
  });
  const update = (notebook: Notebook) => onChange?.(`${JSON.stringify(notebook, null, 1)}\n`);
  const notebook = parsed.notebook;
  const source = useMemo(
    () => ({ session, path, ...(root !== undefined ? { root } : {}) }),
    [session, path, root],
  );
  const execution = useNotebookExecution(source, notebook, onChange ? update : undefined, !!onRun);
  const widgets = useNotebookWidgets(source, notebook, onChange ? update : undefined, !!onRun);
  const inputCellId = execution.execution?.input
    ? execution.execution.cells.find((cell) => cell.state === 'running')?.id
    : undefined;
  useLayoutEffect(() => {
    if (!notebook || !inputCellId || !folded.length) return;
    const inputIndex = notebook.cells.findIndex((cell) => cell.id === inputCellId);
    const next = folded.filter((id) => {
      const index = notebook.cells.findIndex((cell) => cell.id === id);
      return index < 0 || !notebookSectionRange(notebook, index).includes(inputIndex);
    });
    if (next.length !== folded.length) setFolded(next);
  }, [notebook, inputCellId, folded]);
  if (!notebook)
    return (
      <p className="p-6 text-sm text-danger" role="alert">
        {parsed.error}
      </p>
    );
  const select = (id: string, extend = false) => {
    const anchor = selectionAnchor.current ?? active ?? id;
    const from = notebook.cells.findIndex((cell) => cell.id === anchor);
    const to = notebook.cells.findIndex((cell) => cell.id === id);
    setSelected(
      extend
        ? notebook.cells.slice(Math.min(from, to), Math.max(from, to) + 1).map((cell) => cell.id!)
        : [id],
    );
    if (!extend) selectionAnchor.current = id;
    setActive(id);
  };
  const choose = (id: string, edit = false, extend = false) => {
    select(id, extend);
    setEditing(edit ? id : null);
    reveal.current = id;
  };
  const outline = notebookOutline(notebook);
  const hidden = new Set(
    notebook.cells.flatMap((cell, index) =>
      folded.includes(cell.id!) ? notebookSectionRange(notebook, index).slice(1) : [],
    ),
  );
  const { add, replace, execute, operation, keyDown } = notebookActions({
    notebook,
    active,
    selected,
    update,
    choose,
    setEditing,
    run: execution.run,
    onUndo,
    onRedo,
  });
  return (
    <WidgetContext.Provider value={widgets}>
      <NotebookRenderingContext.Provider
        value={{ ...source, onOpenFile, intelligence: execution.intelligenceSupported }}
      >
        <div
          className="relative flex h-full min-h-0 flex-col bg-ground"
          onKeyDown={onChange ? keyDown : undefined}
          onCopy={(event) => {
            if (onChange) notebookClipboard(event, 'copy', notebook, selected, update);
          }}
          onCut={(event) => {
            if (onChange) notebookClipboard(event, 'cut', notebook, selected, update);
          }}
          onPaste={(event) => {
            if (onChange) notebookClipboard(event, 'paste', notebook, selected, update);
          }}
        >
          <NotebookSearch
            notebook={notebook}
            focused={focused}
            onChange={onChange ? update : undefined}
            onReveal={(found) => {
              setMatch(found);
              if (!found) return;
              setFolded([]);
              setActive(found.id);
              if (!found.output) setEditing(found.id);
              reveal.current = found.id;
              revealFocus.current = false;
            }}
          />
          <NotebookToolbar
            notebook={notebook}
            source={{ session, path, ...(root !== undefined ? { root } : {}) }}
            onChange={onChange ? update : undefined}
            onAdd={add}
            onRun={
              execution.supported
                ? () => {
                    void execution.run();
                  }
                : onRun
            }
            onRunCopy={execution.supported ? onRun : undefined}
            running={running || execution.busy}
            onRevealCell={(index) => {
              setFolded([]);
              choose(notebook.cells[index]!.id!);
            }}
            onRunSection={
              execution.supported
                ? (index) => {
                    void execution.run(notebookSectionRange(notebook, index));
                  }
                : undefined
            }
          />
          <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-ground text-fg">
            <div ref={content} className="mx-auto flex max-w-4xl flex-col gap-7 py-6 pr-6 pl-14">
              <p className="text-xs text-fg-muted">{notebook.cells.length} cells</p>
              {widgets.saveWarning && (
                <p role="status" className="text-xs text-fg-muted">
                  {widgets.saveWarning}
                </p>
              )}
              {execution.error && (
                <p role="alert" className="text-xs text-danger">
                  {execution.error}
                </p>
              )}
              {notebook.cells.map((cell, index) =>
                hidden.has(index) ? null : (
                  <NotebookCell
                    key={cell.id}
                    cell={cell}
                    match={match && match.id === cell.id ? match : undefined}
                    sectionCollapsed={folded.includes(cell.id!)}
                    onToggleSection={
                      outline[index]?.level
                        ? () =>
                            setFolded((ids) =>
                              ids.includes(cell.id!)
                                ? ids.filter((id) => id !== cell.id)
                                : [...ids, cell.id!],
                            )
                        : undefined
                    }
                    notebook={notebook}
                    index={index}
                    active={active === cell.id}
                    editing={editing === cell.id}
                    selected={selected.length > 1 && selected.includes(cell.id!)}
                    editable={!!onChange}
                    onSelect={(extend) => select(cell.id!, extend)}
                    onEdit={(edit) => {
                      setActive(cell.id!);
                      setEditing(edit ? cell.id! : null);
                    }}
                    onSource={(source) => update(replaceCellSource(notebook, index, source))}
                    onLanguage={(language) =>
                      replace(index, changeNotebookCellLanguage(cell, language))
                    }
                    onInterrupt={() => {
                      void execution.interrupt();
                    }}
                    execution={
                      execution.execution?.cells.find((item) => item.id === cell.id) ??
                      savedCellExecution(cell)
                    }
                    inputExecution={
                      inputCellId === cell.id ? (execution.execution ?? undefined) : undefined
                    }
                    inputSource={source}
                    onRun={
                      execution.supported
                        ? (range) => {
                            void execution.run(
                              notebook.cells.flatMap((_, at) =>
                                (
                                  range === 'cell'
                                    ? at === index
                                    : range === 'above'
                                      ? at < index
                                      : at >= index
                                )
                                  ? [at]
                                  : [],
                              ),
                            );
                          }
                        : undefined
                    }
                    onExecute={(mode) => execute(index, mode)}
                    onOperation={(action) => operation(index, action)}
                    onSave={() => {
                      requestSave(saverKey(session, path, root));
                    }}
                    onSplit={(offset) => {
                      if (notebook.cells.length >= 2000) return;
                      const source = notebookText(cell.source);
                      const next = {
                        ...newNotebookCell(cell.cell_type),
                        source: source.slice(offset),
                      };
                      const cells = [...notebook.cells];
                      cells.splice(index, 1, { ...cell, source: source.slice(0, offset) }, next);
                      update({ ...notebook, cells });
                      choose(next.id!, true);
                    }}
                  />
                ),
              )}
              {onChange && (
                <div className="flex gap-3">
                  {(['code', 'markdown', 'raw'] as const).map((type) => (
                    <button
                      key={type}
                      disabled={notebook.cells.length >= 2000}
                      className={`${notebookControl} flex items-center gap-1.5 text-xs`}
                      onClick={() => add(type, notebook.cells.length)}
                    >
                      <Plus className="size-3.5" />
                      {type === 'code' ? 'Code' : type === 'markdown' ? 'Markdown' : 'Raw'} cell
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </NotebookRenderingContext.Provider>
    </WidgetContext.Provider>
  );
}
