import { describe, expect, it } from 'vitest';
import { editorIndentationOptions } from '../../../src/features/editor/monaco/monaco-options';

describe('editorIndentationOptions', () => {
  it('makes the explicit spaces-per-level setting authoritative over file detection', () => {
    expect(editorIndentationOptions(4)).toEqual({
      tabSize: 4,
      insertSpaces: true,
      detectIndentation: false,
    });
  });
});
