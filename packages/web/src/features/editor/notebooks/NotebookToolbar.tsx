import { useState } from 'react';
import { ListTree, MoreHorizontal, Play, Plus, Trash2 } from 'lucide-react';
import type { CompilationFileTarget } from '@puddle/shared';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';
import { useNotebookKernelStatus } from '../../../lib/queries/notebook-queries';
import { NotebookKernelControls } from './NotebookKernelControls';
import { notebookKernelsSupported } from '../../../lib/transport/protocol-support';
import { useDaemonVersion } from '../../../lib/queries/queries';
import {
  clearNotebookOutputs,
  notebookOutline,
  type Notebook,
  type NotebookCell,
} from './notebook-format';

const control =
  'flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-sm px-2 py-1.5 text-xs text-fg-secondary transition-colors hover:bg-surface hover:text-fg disabled:cursor-default disabled:opacity-40';

export function NotebookToolbar({
  notebook,
  source,
  onChange,
  onAdd,
  onRevealCell,
  onRun,
  onRunCopy,
  onRunSection,
  running = false,
}: {
  notebook: Notebook;
  source: CompilationFileTarget;
  onChange?: (notebook: Notebook) => void;
  onAdd: (type: NotebookCell['cell_type']) => void;
  onRevealCell: (index: number) => void;
  onRun?: () => void;
  onRunCopy?: () => void;
  onRunSection?: (index: number) => void;
  running?: boolean;
}) {
  const [outlineOpen, setOutlineOpen] = useState(false);
  const version = useDaemonVersion();
  const status = useNotebookKernelStatus(
    source,
    !!onRun && notebookKernelsSupported(version.data?.protocol),
  );
  const busy = running || status.data?.state === 'busy' || status.data?.state === 'starting';
  const environment = status.data?.environment;
  const missingPackages = environment && (!environment.ipykernel || !environment.nbconvert);
  const outline = notebookOutline(notebook);
  const hasOutputs = notebook.cells.some(
    (cell) =>
      cell.cell_type === 'code' &&
      ((cell.outputs?.length ?? 0) > 0 || cell.execution_count != null),
  );
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1 bg-ground px-3 py-2"
      role="toolbar"
      aria-label="Notebook"
    >
      {onChange && (
        <>
          <button
            type="button"
            className={control}
            disabled={notebook.cells.length >= 2000}
            onClick={() => onAdd('code')}
            aria-label="Add code cell"
          >
            <Plus className="size-3.5" />
            Code
          </button>
          <button
            type="button"
            className={control}
            disabled={notebook.cells.length >= 2000}
            onClick={() => onAdd('markdown')}
            aria-label="Add Markdown cell"
          >
            <Plus className="size-3.5" />
            Markdown
          </button>
        </>
      )}
      {onRun && (
        <button
          type="button"
          className={control}
          disabled={busy || missingPackages}
          onClick={onRun}
        >
          <Play className="size-3.5" />
          {busy ? 'Running…' : 'Run All'}
        </button>
      )}
      {onChange && (
        <button
          type="button"
          className={control}
          disabled={!hasOutputs}
          onClick={() => onChange(clearNotebookOutputs(notebook))}
        >
          <Trash2 className="size-3.5" />
          Clear All Outputs
        </button>
      )}
      <Popover open={outlineOpen} onOpenChange={setOutlineOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={control} disabled={outline.length === 0}>
            <ListTree className="size-3.5" />
            Outline
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-72 w-72 overflow-y-auto p-1">
          <nav aria-label="Notebook outline" className="flex flex-col">
            {outline.map((item) => (
              <div
                key={item.index}
                className="group/outline flex items-center"
                style={{ paddingLeft: `calc(var(--spacing) * ${Math.max(0, item.level - 1) * 3})` }}
              >
                <button
                  type="button"
                  className={`${control} min-w-0 flex-1 text-left`}
                  onClick={() => {
                    onRevealCell(item.index);
                    setOutlineOpen(false);
                  }}
                >
                  <span className="w-5 shrink-0 text-fg-muted">{item.index + 1}</span>
                  <span className="truncate">{item.label}</span>
                </button>
                {!!item.level && onRunSection && (
                  <button
                    type="button"
                    disabled={busy}
                    title="Run Section"
                    aria-label={`Run section ${item.label}`}
                    className={`${control} opacity-0 group-hover/outline:opacity-100 focus:opacity-100 pointer-coarse:opacity-100`}
                    onClick={() => {
                      onRunSection(item.index);
                      setOutlineOpen(false);
                    }}
                  >
                    <Play className="size-3.5" />
                  </button>
                )}
              </div>
            ))}
          </nav>
        </PopoverContent>
      </Popover>
      {onChange && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={control} aria-label="More notebook actions">
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {onRunCopy && (
              <DropdownMenuItem disabled={busy} onSelect={onRunCopy}>
                Run to Executed Copy
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={notebook.cells.length >= 2000}
              onSelect={() => onAdd('raw')}
            >
              <Plus />
              Add raw cell
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {onChange && onRun && (
        <NotebookKernelControls
          key={JSON.stringify(source)}
          source={source}
          notebook={notebook}
          onSelect={(kernel) =>
            onChange({ ...notebook, metadata: { ...notebook.metadata, kernelspec: kernel } })
          }
        />
      )}
    </div>
  );
}
