import type { KeyboardEvent } from 'react';
import {
  newNotebookCell,
  notebookText,
  changeNotebookCellLanguage,
  type Notebook,
} from './notebook-format';

/** Pure actions over the current document; all mutations use the shared JSON undo buffer. */
export function notebookActions({
  notebook,
  active,
  selected,
  update,
  choose,
  setEditing,
  run,
  onUndo,
  onRedo,
}: {
  notebook: Notebook;
  active: string | null;
  selected: string[];
  update: (notebook: Notebook) => void;
  choose: (id: string, edit?: boolean, extend?: boolean) => void;
  setEditing: (id: string | null) => void;
  run: (indices: number[]) => Promise<void>;
  onUndo?: () => void;
  onRedo?: () => void;
}) {
  const add = (
    type: Notebook['cells'][number]['cell_type'],
    at = notebook.cells.findIndex((cell) => cell.id === active) + 1,
  ) => {
    if (notebook.cells.length >= 2000) return;
    const cell = newNotebookCell(type);
    const cells = [...notebook.cells];
    cells.splice(active === null ? cells.length : at, 0, cell);
    update({ ...notebook, cells });
    choose(cell.id!, true);
  };
  const replace = (index: number, cell: Notebook['cells'][number]) =>
    update({
      ...notebook,
      cells: notebook.cells.map((value, at) => (at === index ? cell : value)),
    });
  const execute = (index: number, mode: 'stay' | 'next' | 'insert') => {
    if (notebook.cells[index]?.cell_type === 'code') void run([index]);
    setEditing(null);
    if (mode === 'insert' || (mode === 'next' && index === notebook.cells.length - 1))
      add(notebook.cells[index]!.cell_type, index + 1);
    else if (mode === 'next') choose(notebook.cells[index + 1]!.id!);
  };
  const operation = (
    index: number,
    action: 'up' | 'down' | 'delete' | 'duplicate' | 'insert' | 'merge' | 'clear',
  ) => {
    const cells = [...notebook.cells];
    const cell = cells[index]!;
    if (action === 'insert') {
      add('code', index + 1);
      return;
    }
    if (action === 'clear') {
      replace(index, { ...cell, outputs: [], execution_count: null });
      return;
    }
    if (action === 'delete') {
      cells.splice(index, 1);
      if (cells.length) choose(cells[Math.min(index, cells.length - 1)]!.id!);
    }
    if (action === 'up' || action === 'down') {
      const other = index + (action === 'up' ? -1 : 1);
      if (other < 0 || other >= cells.length) return;
      [cells[index], cells[other]] = [cells[other]!, cell];
      choose(cell.id!);
    }
    if (action === 'duplicate') {
      if (cells.length >= 2000) return;
      const copy = { ...structuredClone(cell), id: crypto.randomUUID() };
      cells.splice(index + 1, 0, copy);
      choose(copy.id, true);
    }
    if (action === 'merge') {
      const next = cells[index + 1];
      if (!next || next.cell_type !== cell.cell_type) return;
      cells[index] = {
        ...cell,
        source: `${notebookText(cell.source)}\n${notebookText(next.source)}`,
      };
      cells.splice(index + 1, 1);
      choose(cell.id!, true);
    }
    update({ ...notebook, cells });
  };
  const keyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('.monaco-editor,input,textarea,[role=dialog],[role=menu],[cmdk-root]'))
      return;
    const index = notebook.cells.findIndex((cell) => cell.id === active);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) onRedo?.();
      else onUndo?.();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && selected.length > 1) {
      event.preventDefault();
      void run(notebook.cells.flatMap((cell, at) => (selected.includes(cell.id!) ? [at] : [])));
      return;
    }
    if (event.key === 'Enter' && index >= 0) {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        execute(index, event.shiftKey ? 'next' : event.altKey ? 'insert' : 'stay');
      else setEditing(active);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.max(
        0,
        Math.min(notebook.cells.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
      );
      if (notebook.cells[next]) choose(notebook.cells[next]!.id!, false, event.shiftKey);
    } else if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === 'a' || event.key === 'b') {
        event.preventDefault();
        add('code', Math.max(0, index + (event.key === 'b' ? 1 : 0)));
      }
      if ((event.key === 'm' || event.key === 'y') && index >= 0) {
        event.preventDefault();
        replace(
          index,
          changeNotebookCellLanguage(
            notebook.cells[index]!,
            event.key === 'm' ? 'markdown' : 'python',
          ),
        );
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        update({
          ...notebook,
          cells: notebook.cells.filter((cell) => !selected.includes(cell.id!)),
        });
      }
    }
  };
  return { add, replace, execute, operation, keyDown };
}
