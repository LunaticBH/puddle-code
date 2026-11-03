import {
  ArrowDown,
  ArrowUp,
  ArrowDownToLine,
  ArrowUpToLine,
  Copy,
  Play,
  Plus,
  Trash2,
  Combine,
} from 'lucide-react';
import type { NotebookRunRange } from './NotebookCell';
import type { ReactNode } from 'react';

export function NotebookCellToolbar({
  code,
  onRun,
  busy,
  index,
  count,
  canMerge,
  onOperation,
}: {
  code: boolean;
  onRun?: (range: NotebookRunRange) => void;
  busy: boolean;
  index: number;
  count: number;
  canMerge: boolean;
  onOperation: (
    operation: 'up' | 'down' | 'delete' | 'duplicate' | 'insert' | 'merge' | 'clear',
  ) => void;
}) {
  const action = (label: string, icon: ReactNode, handler: () => void, disabled = false) => (
    <button
      type="button"
      className="cursor-pointer rounded-sm p-1 text-fg-muted hover:bg-surface hover:text-fg disabled:cursor-default disabled:opacity-40"
      title={label}
      aria-label={label}
      onClick={handler}
      disabled={disabled}
    >
      {icon}
    </button>
  );
  return (
    <div className="ml-auto flex flex-wrap items-center opacity-0 focus-within:opacity-100 group-hover/cell:opacity-100 pointer-coarse:opacity-100">
      {code && onRun && (
        <>
          {action('Run Cell', <Play className="size-3.5" />, () => onRun('cell'), busy)}
          {action(
            'Run Above',
            <ArrowUpToLine className="size-3.5" />,
            () => onRun('above'),
            busy || index === 0,
          )}
          {action(
            'Run Cell and Below',
            <ArrowDownToLine className="size-3.5" />,
            () => onRun('below'),
            busy,
          )}
        </>
      )}
      {action(
        'Insert cell below',
        <Plus className="size-3.5" />,
        () => onOperation('insert'),
        count >= 2000,
      )}
      {action(
        'Duplicate cell',
        <Copy className="size-3.5" />,
        () => onOperation('duplicate'),
        count >= 2000,
      )}
      {action(
        'Merge with next cell',
        <Combine className="size-3.5" />,
        () => onOperation('merge'),
        !canMerge,
      )}
      {action(
        'Move cell up',
        <ArrowUp className="size-3.5" />,
        () => onOperation('up'),
        index === 0,
      )}
      {action(
        'Move cell down',
        <ArrowDown className="size-3.5" />,
        () => onOperation('down'),
        index === count - 1,
      )}
      {action('Delete cell', <Trash2 className="size-3.5" />, () => onOperation('delete'))}
    </div>
  );
}
