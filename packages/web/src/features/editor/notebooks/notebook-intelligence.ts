import type { CompilationFileTarget, NotebookIntelligenceResponse } from '@puddle/shared';
import { api } from '../../../lib/transport/api';
import { monaco } from '../monaco/monaco-setup';

/** Kernel assistance is scoped to this exact cell model and never starts a kernel. */
export function bindNotebookIntelligence(
  model: monaco.editor.ITextModel,
  source: CompilationFileTarget,
): monaco.IDisposable {
  const query = async (
    kind: 'complete' | 'inspect',
    position: monaco.Position,
    token: monaco.CancellationToken,
  ) => {
    const code = model.getValue();
    if (code.length > 65536 || token.isCancellationRequested) return null;
    const version = model.getVersionId();
    try {
      const response = await api<NotebookIntelligenceResponse>(
        'POST',
        '/api/notebooks/intelligence',
        { source, kind, code, cursor: [...code.slice(0, model.getOffsetAt(position))].length },
      );
      if (token.isCancellationRequested || model.isDisposed() || version !== model.getVersionId())
        return null;
      return { response, code };
    } catch {
      return null;
    }
  };
  const register = () => {
    const language = model.getLanguageId();
    if (language === 'markdown' || language === 'plaintext') return [];
    return [
      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: ['.'],
        async provideCompletionItems(current, position, _context, token) {
          if (current !== model) return { suggestions: [] };
          const found = await query('complete', position, token);
          if (!found) return { suggestions: [] };
          const { response, code } = found;
          const start = model.getPositionAt([...code].slice(0, response.start).join('').length);
          const end = model.getPositionAt([...code].slice(0, response.end).join('').length);
          const range = new monaco.Range(
            start.lineNumber,
            start.column,
            end.lineNumber,
            end.column,
          );
          return {
            suggestions: response.matches.map((label) => ({
              label,
              insertText: label,
              kind: monaco.languages.CompletionItemKind.Text,
              range,
            })),
          };
        },
      }),
      monaco.languages.registerHoverProvider(language, {
        async provideHover(current, position, token) {
          if (current !== model) return null;
          const found = await query('inspect', position, token);
          if (!found?.response.documentation) return null;
          // Kernel documentation is untrusted text, never HTML or executable command links.
          const value = found.response.documentation
            // eslint-disable-next-line no-control-regex
            .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
            .replace(/[\\`*_{}[\]()#+.!<>-]/g, '\\$&');
          return { contents: [{ value, isTrusted: false, supportHtml: false }] };
        },
      }),
    ];
  };
  let providers = register();
  const language = model.onDidChangeLanguage(() => {
    providers.forEach((provider) => provider.dispose());
    providers = register();
  });
  return {
    dispose() {
      language.dispose();
      providers.forEach((provider) => provider.dispose());
    },
  };
}
