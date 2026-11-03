import { describe, expect, it } from 'vitest';
import {
  notebookOutputText,
  clearNotebookOutputs,
  notebookOutline,
  notebookText,
  notebookTextEdit,
  parseNotebook,
  replaceCellSource,
} from '../../../src/features/editor/notebooks/notebook-format';
import { previewKind } from '../../../src/features/editor/previews/preview-kind';

const document = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: 'python3' } },
  extension: { preserved: true },
  cells: [
    {
      id: 'cell',
      cell_type: 'code',
      source: ['print(1)\n'],
      execution_count: 1,
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
      metadata: { tags: ['keep'] },
      extra: 42,
    },
  ],
};

describe('notebook documents', () => {
  it('clears only execution data and builds a bounded cell outline', () => {
    const parsed = parseNotebook(JSON.stringify(document));
    parsed.cells.push({
      cell_type: 'markdown',
      source: '# Heading\nMore text',
      metadata: { keep: true },
    });
    const cleared = clearNotebookOutputs(parsed);
    expect(cleared.cells[0]).toEqual({ ...parsed.cells[0], outputs: [], execution_count: null });
    expect(cleared.cells[1]).toBe(parsed.cells[1]);
    expect(cleared.metadata).toBe(parsed.metadata);
    expect(parsed.cells[0]?.outputs).toHaveLength(1);
    expect(notebookOutline(parsed)).toEqual([
      { index: 0, label: 'print(1)', level: 0 },
      { index: 1, label: 'Heading', level: 1 },
    ]);
  });

  it('keeps unchanged output data out of the cell edit undo entry', () => {
    const suffix = ',"image/png":"' + 'x'.repeat(100_000) + '"}';
    const before = '{"source":"a"' + suffix;
    const after = '{"source":"ab"' + suffix;
    const edit = notebookTextEdit(before, after);
    expect(edit.text).toBe('b');
    expect(edit.start).toBe(edit.end);
    expect(before.slice(0, edit.start) + edit.text + before.slice(edit.end)).toBe(after);
    for (const [left, right] of [
      ['same', 'same'],
      ['', 'new'],
      ['old', ''],
      ['old', 'new'],
    ]) {
      const change = notebookTextEdit(left!, right!);
      expect(left!.slice(0, change.start) + change.text + left!.slice(change.end)).toBe(right);
    }
  });
  it('classifies notebook files and preserves metadata and unknown fields while editing', () => {
    expect(previewKind('work/Analysis.IPYNB')).toBe('notebook');
    const parsed = parseNotebook(JSON.stringify(document));
    const edited = replaceCellSource(parsed, 0, 'print(2)\nprint(3)');
    expect(edited.metadata).toEqual(document.metadata);
    expect(edited.extension).toEqual(document.extension);
    expect(edited.cells[0]).toMatchObject({
      id: 'cell',
      metadata: { tags: ['keep'] },
      extra: 42,
      outputs: document.cells[0]!.outputs,
      execution_count: 1,
      source: ['print(2)\n', 'print(3)'],
    });
    expect(parsed.cells[0]!.outputs).toHaveLength(1);
    expect(parseNotebook(JSON.stringify(edited))).toEqual(edited);
  });

  it('handles string/list sources, saved output and coloured tracebacks', () => {
    expect(notebookText(['a\n', 'b'])).toBe('a\nb');
    expect(notebookText('a\nb')).toBe('a\nb');
    expect(notebookText({ malicious: true })).toBe('');
    expect(
      notebookOutputText({ output_type: 'error', traceback: ['\x1b[31mError\x1b[0m', 'detail'] }),
    ).toBe('Error\ndetail');
    expect(
      notebookOutputText({ output_type: 'display_data', data: { 'text/plain': ['value'] } }),
    ).toBe('value');
  });

  it('rejects invalid, unsupported or excessive documents without dropping cells', () => {
    expect(() => parseNotebook('{')).toThrow(/valid JSON/);
    expect(() => parseNotebook(JSON.stringify({ ...document, nbformat: 3 }))).toThrow(/version 4/);
    expect(() => parseNotebook(JSON.stringify({ ...document, cells: [{ source: {} }] }))).toThrow(
      /valid cells/,
    );
    expect(() =>
      parseNotebook(JSON.stringify({ ...document, cells: Array(2001).fill(document.cells[0]) })),
    ).toThrow(/2,000/);
  });
});
