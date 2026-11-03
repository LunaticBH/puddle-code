import { describe, expect, it } from 'vitest';
import {
  dirtyChangeAtLine,
  dirtyDecorations,
  dirtyPeekAfterLine,
  dirtyPeekLineCount,
} from '../../../src/features/editor/monaco/dirty-diff';

describe('dirty diff decoration mapping', () => {
  it('maps additions and replacements with surplus inserted lines', () => {
    expect(
      dirtyDecorations(
        [
          {
            originalStartLineNumber: 2,
            originalEndLineNumber: 0,
            modifiedStartLineNumber: 2,
            modifiedEndLineNumber: 3,
          },
          {
            originalStartLineNumber: 5,
            originalEndLineNumber: 5,
            modifiedStartLineNumber: 6,
            modifiedEndLineNumber: 8,
          },
        ],
        8,
      ),
    ).toEqual([
      { startLineNumber: 2, endLineNumber: 3, kind: 'added' },
      { startLineNumber: 6, endLineNumber: 6, kind: 'modified' },
      { startLineNumber: 7, endLineNumber: 8, kind: 'added' },
    ]);
  });

  it('places deletion triangles between lines and at both file boundaries', () => {
    expect(
      dirtyDecorations(
        [
          {
            originalStartLineNumber: 1,
            originalEndLineNumber: 1,
            modifiedStartLineNumber: 1,
            modifiedEndLineNumber: 0,
          },
          {
            originalStartLineNumber: 4,
            originalEndLineNumber: 4,
            modifiedStartLineNumber: 3,
            modifiedEndLineNumber: 0,
          },
          {
            originalStartLineNumber: 8,
            originalEndLineNumber: 8,
            modifiedStartLineNumber: 7,
            modifiedEndLineNumber: 0,
          },
        ],
        6,
      ),
    ).toEqual([
      { startLineNumber: 1, endLineNumber: 1, kind: 'deleted-before' },
      { startLineNumber: 3, endLineNumber: 3, kind: 'deleted-before' },
      { startLineNumber: 6, endLineNumber: 6, kind: 'deleted-after' },
    ]);
  });

  it('marks surplus replacement deletions after the modified portion', () => {
    expect(
      dirtyDecorations(
        [
          {
            originalStartLineNumber: 2,
            originalEndLineNumber: 5,
            modifiedStartLineNumber: 2,
            modifiedEndLineNumber: 3,
          },
        ],
        5,
      ),
    ).toEqual([
      { startLineNumber: 2, endLineNumber: 3, kind: 'modified' },
      { startLineNumber: 4, endLineNumber: 4, kind: 'deleted-before' },
    ]);
  });

  it('resolves gutter clicks to additions, replacements, and boundary deletions', () => {
    const changes = [
      {
        originalStartLineNumber: 2,
        originalEndLineNumber: 0,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 3,
      },
      {
        originalStartLineNumber: 5,
        originalEndLineNumber: 6,
        modifiedStartLineNumber: 6,
        modifiedEndLineNumber: 6,
      },
      {
        originalStartLineNumber: 9,
        originalEndLineNumber: 9,
        modifiedStartLineNumber: 8,
        modifiedEndLineNumber: 0,
      },
    ];
    expect(dirtyChangeAtLine(changes, 2, 7)).toBe(changes[0]);
    expect(dirtyChangeAtLine(changes, 6, 7)).toBe(changes[1]);
    expect(dirtyChangeAtLine(changes, 7, 7, 'deleted-after')).toBe(changes[2]);
    expect(dirtyChangeAtLine(changes, 4, 7)).toBeNull();
  });

  it('places peeks after inserted text and immediately at deletion boundaries', () => {
    expect(
      dirtyPeekAfterLine(
        {
          originalStartLineNumber: 2,
          originalEndLineNumber: 0,
          modifiedStartLineNumber: 2,
          modifiedEndLineNumber: 4,
        },
        10,
      ),
    ).toBe(4);
    expect(
      dirtyPeekAfterLine(
        {
          originalStartLineNumber: 1,
          originalEndLineNumber: 2,
          modifiedStartLineNumber: 1,
          modifiedEndLineNumber: 0,
        },
        10,
      ),
    ).toBe(0);
    expect(
      dirtyPeekAfterLine(
        {
          originalStartLineNumber: 11,
          originalEndLineNumber: 12,
          modifiedStartLineNumber: 11,
          modifiedEndLineNumber: 0,
        },
        10,
      ),
    ).toBe(10);
  });

  it('bounds the inline viewer height while fitting ordinary hunks', () => {
    expect(
      dirtyPeekLineCount({
        originalStartLineNumber: 2,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 2,
      }),
    ).toBe(6);
    expect(
      dirtyPeekLineCount({
        originalStartLineNumber: 1,
        originalEndLineNumber: 20,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 20,
      }),
    ).toBe(14);
  });
});
