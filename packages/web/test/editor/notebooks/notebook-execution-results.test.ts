import { expect, it } from 'vitest';
import type { NotebookExecution } from '@puddle/shared';
import {
  mergeNotebookExecution,
  savedCellExecution,
} from '../../../src/features/editor/notebooks/notebook-execution-results';
import {
  parseNotebook,
  clearNotebookOutputs,
} from '../../../src/features/editor/notebooks/notebook-format';

it('attaches output by cell identity without replacing edits, resurrecting deletions or undoing output clearing', () => {
  const notebook = parseNotebook(
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { custom: true },
      cells: [
        {
          id: 'second',
          cell_type: 'code',
          source: 'newer edit',
          metadata: { tags: ['retain'] },
          outputs: [],
          execution_count: null,
        },
        { id: 'first', cell_type: 'markdown', source: '# Converted', metadata: {} },
      ],
    }),
  );
  const execution: NotebookExecution = {
    id: '00000000-0000-4000-8000-000000000001',
    revision: 4,
    state: 'succeeded',
    cells: [
      {
        id: 'first',
        source: 'old code',
        state: 'succeeded',
        outputs: [],
        execution_count: 1,
        revision: 2,
      },
      {
        id: 'second',
        source: 'submitted code',
        state: 'succeeded',
        outputs: [{ output_type: 'stream', text: 'result' }],
        execution_count: 2,
        revision: 2,
      },
      {
        id: 'deleted',
        source: 'gone',
        state: 'succeeded',
        outputs: [],
        execution_count: 3,
        revision: 2,
      },
    ],
  };
  const result = mergeNotebookExecution(notebook, execution);
  expect(result.cells).toHaveLength(2);
  expect(result.cells[0]).toMatchObject({
    source: 'newer edit',
    execution_count: 2,
    outputs: [{ text: 'result' }],
    metadata: { tags: ['retain'], puddle_execution: { source: 'submitted code' } },
  });
  expect(result.cells[1]).toBe(notebook.cells[1]);
  expect(result.metadata).toBe(notebook.metadata);
  const cleared = clearNotebookOutputs(result);
  expect(mergeNotebookExecution(cleared, execution)).toBe(cleared);
});

it('does not show a saved running snapshot as an actively executing cell', () => {
  expect(
    savedCellExecution({
      cell_type: 'code',
      source: 'print(2)',
      metadata: {
        puddle_execution: { state: 'running', source: 'print(1)' },
      },
    }),
  ).toEqual({ state: 'saved', source: 'print(1)' });
});
