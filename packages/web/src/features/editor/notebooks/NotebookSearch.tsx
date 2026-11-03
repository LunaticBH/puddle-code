import { useEffect, useRef, useState } from 'react';
import { useFindControls } from '../../find/use-find-controls';
import { findMatches, findMatcher } from '../../find/find-matches';
import { FindOverlay } from '../previews/preview-controls';
import {
  notebookText,
  notebookOutputText,
  replaceCellSource,
  type Notebook,
} from './notebook-format';

export interface NotebookMatch {
  id: string;
  start: number;
  end: number;
  output: boolean;
}
export function NotebookSearch({
  notebook,
  focused,
  onReveal,
  onChange,
}: {
  notebook: Notebook;
  focused: boolean;
  onReveal: (match: NotebookMatch | null) => void;
  onChange?: (notebook: Notebook) => void;
}) {
  const [includeOutput, setIncludeOutput] = useState(false);
  const [replacement, setReplacement] = useState('');
  const selected = useRef<NotebookMatch | null>(null);
  const matches = useRef<NotebookMatch[]>([]);
  const index = useRef(-1);
  const refreshing = useRef(false);
  const controls = useFindControls({
    shortcutEnabled: focused,
    onFind: (query, options, direction) => {
      const previous = selected.current;
      if (direction === 'reset') {
        matches.current = [];
        index.current = -1;
        for (const cell of notebook.cells) {
          const fields = [
            { text: notebookText(cell.source), output: false },
            ...(includeOutput
              ? [{ text: (cell.outputs ?? []).map(notebookOutputText).join('\n'), output: true }]
              : []),
          ];
          for (const field of fields) {
            const found = findMatches(
              field.text,
              query,
              options,
              Math.max(0, 1000 - matches.current.length),
            );
            if (found.invalid) return { index: -1, count: 0, invalid: true };
            matches.current.push(
              ...found.matches.map((match) => ({ ...match, id: cell.id!, output: field.output })),
            );
            if (matches.current.length >= 1000) break;
          }
          if (matches.current.length >= 1000) break;
        }
        if (refreshing.current && previous) {
          const nearest = matches.current.findIndex(
            (match) =>
              match.id === previous.id &&
              match.output === previous.output &&
              match.start >= previous.start,
          );
          index.current = nearest >= 0 ? nearest - 1 : -1;
        }
      }
      const count = matches.current.length;
      index.current = count
        ? (index.current + (direction === 'previous' ? -1 : 1) + count) % count
        : -1;
      selected.current = matches.current[index.current] ?? null;
      if (!refreshing.current) onReveal(selected.current);
      return { index: index.current, count, limited: count >= 1000 };
    },
    onClear: () => {
      selected.current = null;
      onReveal(null);
    },
  });
  useEffect(() => {
    controls.refresh();
  }, [includeOutput, controls.refresh]);
  const replace = (all: boolean) => {
    const matcher = findMatcher(controls.query, controls.options);
    if (!matcher || !onChange) return;
    let next = notebook;
    notebook.cells.forEach((cell, at) => {
      const text = notebookText(cell.source);
      const match = selected.current;
      if (all) next = replaceCellSource(next, at, text.replace(matcher, replacement));
      else if (match && !match.output && match.id === cell.id)
        next = replaceCellSource(
          next,
          at,
          text.slice(0, match.start) +
            text.slice(match.start, match.end).replace(matcher, replacement) +
            text.slice(match.end),
        );
    });
    onChange(next);
    // Refresh after the shared document's next render, not against stale source offsets.
    matches.current = [];
    selected.current = null;
  };
  useEffect(() => {
    // Keep offsets current during edits and streamed output without moving the typing cursor.
    refreshing.current = selected.current !== null;
    if (controls.open) controls.refresh();
    refreshing.current = false;
  }, [notebook, controls.open, controls.refresh]);
  return (
    <>
      <FindOverlay controls={controls} />
      {controls.open && (
        <div className="absolute right-2 top-10 z-30 flex max-w-full flex-wrap items-center gap-2 rounded-b-md bg-surface px-2 py-1.5 text-xs text-fg-secondary">
          <label className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              checked={includeOutput}
              onChange={(event) => setIncludeOutput(event.target.checked)}
            />
            Include output
          </label>
          {onChange && (
            <>
              <input
                aria-label="Replace in notebook"
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
                placeholder="Replace"
                className="min-w-0 bg-ground px-2 py-1 outline-none"
              />
              <button
                type="button"
                className="cursor-pointer hover:text-fg"
                disabled={!controls.query || !!selected.current?.output}
                onClick={() => replace(false)}
              >
                Replace
              </button>
              <button
                type="button"
                className="cursor-pointer hover:text-fg"
                disabled={!controls.query}
                onClick={() => replace(true)}
              >
                Replace all
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
