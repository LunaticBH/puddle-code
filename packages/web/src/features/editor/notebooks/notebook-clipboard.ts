import type { ClipboardEvent } from 'react';
import { toast } from 'sonner';
import { parseNotebook, type Notebook } from './notebook-format';

/** Native explicit copy/paste gestures; Monaco and prose selections retain their own clipboard. */
export function notebookClipboard(
  event: ClipboardEvent,
  action: 'copy' | 'cut' | 'paste',
  notebook: Notebook,
  selected: string[],
  update: (notebook: Notebook) => void,
): void {
  if ((event.target as HTMLElement).closest('.monaco-editor,input,textarea') || !selected.length)
    return;
  if (action !== 'paste' && window.getSelection()?.toString()) return;
  if (action === 'paste') {
    const text = event.clipboardData.getData('text/plain');
    if (text.length > 5 * 1024 * 1024) return;
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || !('puddle_notebook_cells' in value)) return;
      const copied = parseNotebook(
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {},
          cells: value.puddle_notebook_cells,
        }),
      ).cells;
      event.preventDefault();
      if (notebook.cells.length + copied.length > 2000) {
        toast.error('A notebook can contain at most 2,000 cells');
        return;
      }
      const cells = [...notebook.cells];
      const last = Math.max(
        ...cells.flatMap((cell, index) => (selected.includes(cell.id!) ? [index] : [])),
      );
      cells.splice(last + 1, 0, ...copied.map((cell) => ({ ...cell, id: crypto.randomUUID() })));
      update({ ...notebook, cells });
    } catch {
      /* Ordinary text remains available to the browser. */
    }
  } else {
    const cells = notebook.cells.filter((cell) => selected.includes(cell.id!));
    event.clipboardData.setData('text/plain', JSON.stringify({ puddle_notebook_cells: cells }));
    event.preventDefault();
    if (action === 'cut')
      update({ ...notebook, cells: notebook.cells.filter((cell) => !selected.includes(cell.id!)) });
  }
}
