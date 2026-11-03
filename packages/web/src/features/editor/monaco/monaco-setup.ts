/**
 * Self-hosted Monaco bootstrap (SPEC §12: no CDN — hosts can be offline;
 * terminal, editor, and chrome share one palette).
 *
 * Imported ONLY from lazily-loaded editor code (mirrors how LazyTerminal.tsx
 * isolates xterm): this drags in the full monaco-editor bundle plus its
 * workers, and must never sit on an eager import path.
 *
 * `@monaco-editor/react`'s `loader` defaults to fetching Monaco from a CDN
 * (jsdelivr) at runtime; `loader.config({ monaco })` below points it at this
 * locally-bundled instance instead, which is what makes that CDN fetch never
 * happen (verified against the built output — see the task report).
 */
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { loader } from '@monaco-editor/react';
import { monacoThemeFromCss, onThemeChange } from '../../../lib/appearance/theme';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

/** The one Monaco theme puddle ever defines — a stock vs-dark is forbidden. */
const THEME_NAME = 'puddle';

function defineTheme(): void {
  monaco.editor.defineTheme(THEME_NAME, monacoThemeFromCss());
}

defineTheme();

// Kills the @monaco-editor/react CDN path: it now uses this bundled instance.
loader.config({ monaco });

// Monaco 0.55 caches fallback-font widths even after font-display: swap
// replaces the glyphs. Refresh every editor's metrics so bracket highlights,
// selections and carets follow the displayed text. `ready` covers the initial
// load; `loadingdone` also covers faces first requested by later editor mounts.
void document.fonts.ready.then(() => monaco.editor.remeasureFonts());
document.fonts.addEventListener('loadingdone', monaco.editor.remeasureFonts);
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    document.fonts.removeEventListener('loadingdone', monaco.editor.remeasureFonts);
  });
}

// Re-theme every live editor on a theme switch, no reload (mirrors Terminal.tsx).
onThemeChange(() => {
  defineTheme();
  monaco.editor.setTheme(THEME_NAME);
});

export { monaco, THEME_NAME };
