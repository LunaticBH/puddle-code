import { expect, it } from 'vitest';
import { phoneDiff } from '../../src/features/mobile/phone-diff';

it('numbers and highlights replacements with unchanged context', () => {
  const diff = phoneDiff('heading\nold value\ntail\n', 'heading\nnew value\ntail\n')!;
  expect([diff.additions, diff.deletions]).toEqual([1, 1]);
  expect(diff.hunks[0]!.before[1]).toEqual({
    number: 2,
    changed: true,
    spans: [
      { text: 'old', changed: true },
      { text: ' value', changed: false },
    ],
  });
  expect(diff.hunks[0]!.after[1]).toEqual({
    number: 2,
    changed: true,
    spans: [
      { text: 'new', changed: true },
      { text: ' value', changed: false },
    ],
  });
  expect(diff.hunks[0]!.after[2]!.number).toBe(3);
});

it('handles added and deleted files, empty lines and missing final newlines', () => {
  const added = phoneDiff('', '<script>inert()</script>\n\nlast')!;
  expect(added.hunks[0]!.before).toEqual([]);
  expect(added.hunks[0]!.after.map((line) => line.number)).toEqual([1, 2, 3]);
  expect(added.additions).toBe(3);
  expect(added.hunks[0]!.after[0]!.spans[0]!.text).toBe('<script>inert()</script>');
  const removed = phoneDiff('gone\n', '')!;
  expect(removed.hunks[0]!.after).toEqual([]);
  expect(removed.deletions).toBe(1);
  expect(phoneDiff('same', 'same')!.hunks).toEqual([]);
});

it('keeps distant changes in separate stacked groups with their real line numbers', () => {
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
  const changed = [...lines];
  changed[1] = 'first edit';
  changed[27] = 'second edit';
  const diff = phoneDiff(lines.join('\n'), changed.join('\n'))!;
  expect(diff.hunks).toHaveLength(2);
  expect(diff.hunks[1]!.after.find((line) => line.changed)?.number).toBe(28);
});
