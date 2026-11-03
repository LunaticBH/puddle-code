import type * as Monaco from 'monaco-editor';

/**
 * Monaco detects indentation from each model by default, which silently
 * overrides its `tabSize` construction option. Puddle exposes an explicit
 * "Spaces per indent level" setting, so every Monaco surface must disable
 * that detection and apply the user's value to both display and new edits.
 */
export function editorIndentationOptions(
  tabSize: number,
): Pick<Monaco.editor.IGlobalEditorOptions, 'tabSize' | 'insertSpaces' | 'detectIndentation'> {
  return {
    tabSize,
    insertSpaces: true,
    detectIndentation: false,
  };
}
