import { NotebookCellToolbar } from './NotebookCellToolbar';
import type { NotebookMatch } from './NotebookSearch';
import { useEffect, useRef, useState } from 'react';
import { Play, Square, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { NotebookCellEditor } from './NotebookCellEditor';
import { NotebookLanguagePicker } from './NotebookLanguagePicker';
import { NotebookHtml, NotebookOutputView } from './NotebookOutput';
import { NotebookInputPrompt } from './NotebookInputPrompt';
import type { CompilationFileTarget, NotebookExecution } from '@puddle/shared';
import {
  notebookText,
  notebookCellLanguage,
  type Notebook,
  type NotebookCell as Cell,
} from './notebook-format';

export type NotebookRunRange = 'cell' | 'above' | 'below';
export const notebookControl =
  'cursor-pointer rounded-sm p-1 text-fg-muted transition-colors hover:bg-surface hover:text-fg disabled:cursor-default disabled:opacity-40';

export function NotebookCell({
  cell,
  notebook,
  index,
  active,
  editing,
  selected,
  editable,
  onSelect,
  onEdit,
  onSource,
  onLanguage,
  onExecute,
  onRun,
  onInterrupt,
  onOperation,
  onSplit,
  onSave,
  execution,
  inputExecution,
  inputSource,
  match,
  onToggleSection,
  sectionCollapsed,
}: {
  cell: Cell;
  notebook: Notebook;
  index: number;
  active: boolean;
  editing: boolean;
  selected: boolean;
  editable: boolean;
  onSelect: (extend: boolean) => void;
  onEdit: (editing: boolean) => void;
  onSource: (source: string) => void;
  onLanguage: (language: string) => void;
  onExecute: (mode: 'stay' | 'next' | 'insert') => void;
  onRun?: (range: NotebookRunRange) => void;
  onInterrupt?: () => void;
  onOperation: (
    operation: 'up' | 'down' | 'delete' | 'duplicate' | 'insert' | 'merge' | 'clear',
  ) => void;
  onSplit: (offset: number) => void;
  onSave: () => void;
  match?: NotebookMatch;
  onToggleSection?: () => void;
  sectionCollapsed?: boolean;
  execution?: { state: string; elapsed_ms?: number; source: string };
  inputExecution?: NotebookExecution;
  inputSource?: CompilationFileTarget;
}) {
  const section = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const input = inputSource ? inputExecution?.input : undefined;
  useEffect(() => {
    if (match?.output || input) setCollapsed(false);
  }, [match, input]);
  const outputCollapsed = collapsed && !input;
  const code = cell.cell_type === 'code';
  const source = notebookText(cell.source);
  const busy = execution?.state === 'running' || execution?.state === 'queued';
  const language = notebookCellLanguage(cell, notebook);
  const action = (label: string, icon: React.ReactNode, handler: () => void, disabled = false) => (
    <button
      type="button"
      className={notebookControl}
      title={label}
      aria-label={label}
      onClick={handler}
      disabled={disabled}
    >
      {icon}
    </button>
  );
  return (
    <section
      ref={section}
      data-notebook-cell={index}
      data-cell-id={cell.id}
      tabIndex={active ? 0 : -1}
      aria-label={`Cell ${index + 1}`}
      aria-current={active || undefined}
      className={`group/cell relative min-w-0 outline-none ${selected ? 'bg-surface' : ''}`}
      onMouseDown={(event) => {
        if (event.shiftKey && !(event.target as HTMLElement).closest('.monaco-editor,input,button'))
          event.preventDefault();
      }}
      onFocus={() => {
        if (!active) onSelect(false);
      }}
      onClick={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          code &&
          !(event.target as HTMLElement).closest('.monaco-editor,a,button,input')
        ) {
          event.preventDefault();
          onRun?.('cell');
          return;
        }
        if (!(event.target as HTMLElement).closest('button,input,[role=option]'))
          onSelect(event.shiftKey && !(event.target as HTMLElement).closest('.monaco-editor'));
      }}
    >
      <div className="absolute -left-10 top-9 w-9 text-center font-mono text-xs text-fg-muted">
        <button
          type="button"
          className={`${notebookControl} group/run relative w-full`}
          disabled={!editable || (code && (!onRun || (!busy && !source.trim())))}
          title={
            code
              ? busy
                ? 'Interrupt execution'
                : 'Run Cell (⌘/Ctrl+Enter)'
              : editing
                ? 'Show rendered cell'
                : 'Edit cell source'
          }
          aria-label={
            code
              ? busy
                ? 'Interrupt execution'
                : 'Run Cell'
              : editing
                ? 'Show rendered cell'
                : 'Edit cell source'
          }
          onClick={() => {
            if (code) {
              if (busy) onInterrupt?.();
              else onRun?.('cell');
            } else onEdit(!editing);
          }}
        >
          <span
            className={
              code && onRun ? 'group-hover/run:invisible group-focus-visible/run:invisible' : ''
            }
          >
            {code ? `[${busy ? '*' : (cell.execution_count ?? ' ')}]` : editing ? '[›]' : '[ ]'}
          </span>
          {code &&
            onRun &&
            (busy ? (
              <Square className="absolute inset-0 m-auto hidden size-3.5 group-hover/run:block group-focus-visible/run:block" />
            ) : (
              <Play className="absolute inset-0 m-auto hidden size-3.5 group-hover/run:block group-focus-visible/run:block" />
            ))}
        </button>
      </div>
      <div className="mb-2 flex min-h-7 items-center gap-2 text-xs text-fg-muted">
        {onToggleSection &&
          action(
            sectionCollapsed ? 'Expand section' : 'Fold section',
            sectionCollapsed ? (
              <ChevronRight className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            ),
            onToggleSection,
          )}
        {editable ? (
          <NotebookLanguagePicker
            language={cell.cell_type === 'raw' ? 'raw' : language}
            onChange={onLanguage}
          />
        ) : (
          <span className="font-mono">{cell.cell_type === 'raw' ? 'raw' : language}</span>
        )}
        {execution && (
          <span role="status">
            {execution.state}
            {execution.elapsed_ms !== undefined
              ? ` · ${(execution.elapsed_ms / 1000).toFixed(1)}s`
              : ''}
          </span>
        )}
        {execution && execution.source !== source && (
          <span title="The source changed after this execution">Source changed</span>
        )}
        {editable && (
          <NotebookCellToolbar
            code={code}
            onRun={onRun}
            busy={busy}
            index={index}
            count={notebook.cells.length}
            canMerge={cell.cell_type === notebook.cells[index + 1]?.cell_type}
            onOperation={onOperation}
          />
        )}
      </div>
      {editable && (code || editing) ? (
        <NotebookCellEditor
          value={source}
          match={match && !match.output ? match : undefined}
          language={language}
          label={`Cell ${index + 1} source`}
          focus={active && editing && !match}
          onChange={(value) => {
            if (value !== source) onSource(value);
          }}
          onExecute={onExecute}
          onEscape={() => {
            onEdit(false);
            section.current?.focus();
          }}
          onSave={onSave}
          onSplit={onSplit}
        />
      ) : cell.cell_type === 'markdown' ? (
        <div
          onDoubleClick={() => {
            if (editable) onEdit(true);
          }}
          className={editable ? 'cursor-text' : ''}
        >
          <NotebookHtml text={source} markdown attachments={cell.attachments} />
        </div>
      ) : (
        <pre
          className="overflow-x-auto whitespace-pre-wrap font-mono text-sm"
          onDoubleClick={() => {
            if (editable) onEdit(true);
          }}
        >
          {source}
        </pre>
      )}
      {(!!cell.outputs?.length || input) && (
        <div className="mt-2" role="group" aria-label={`Cell ${index + 1} output`}>
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            {action(
              outputCollapsed ? 'Expand output' : 'Collapse output',
              outputCollapsed ? (
                <ChevronRight className="size-3" />
              ) : (
                <ChevronDown className="size-3" />
              ),
              () => setCollapsed(!collapsed),
              !!input,
            )}
            <span>Output</span>
            {editable &&
              action('Clear cell output', <Trash2 className="size-3" />, () =>
                onOperation('clear'),
              )}
          </div>
          {!outputCollapsed && (
            <div className="max-h-96 overflow-auto">
              {cell.outputs?.map((output, at) => (
                <div key={at} className="mt-2">
                  <NotebookOutputView output={output} />
                </div>
              ))}
              {input && inputExecution && inputSource && (
                <NotebookInputPrompt
                  key={`${inputExecution.id}:${input.id}`}
                  source={inputSource}
                  execution={inputExecution}
                  onInterrupt={onInterrupt}
                />
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
