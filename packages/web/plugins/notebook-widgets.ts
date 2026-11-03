import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const id = 'virtual:notebook-widget-runtime';

function inlineCss(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/src:[^;}]+;?/g, (source) => {
      // Embedded fonts only need the modern browser format.
      const woff2 = source.match(/url\([^)]+\.woff2\)\s*format\([^)]+\)/)?.[0];
      return woff2 ? `src:${woff2};` : source.includes('.eot') ? '' : source;
    })
    .replace(/@import\s+['"]([^'"]+)['"]\s*;/g, (_all, imported: string) =>
      inlineCss(resolve(dirname(path), imported)),
    )
    .replace(/url\((['"]?)([^)'"\s]+)\1\)/g, (all, _quote, url: string) => {
      if (/^(data:|https?:|#)/.test(url)) return all;
      const asset = resolve(dirname(path), url.split(/[?#]/)[0]!);
      const mime = extname(asset) === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
      return `url(data:${mime};base64,${readFileSync(asset).toString('base64')})`;
    });
}

/** Ship the official renderer inside an opaque-origin frame, without runtime CDN dependencies for core widgets. */
export function notebookWidgets(): Plugin {
  let pending: Promise<string> | undefined;
  return {
    name: 'puddle:notebook-widgets',
    resolveId(source) {
      return source === id ? '\0' + id : undefined;
    },
    async load(source) {
      if (source !== '\0' + id) return;
      pending ??= (async () => {
        const result = await build({
          entryPoints: [
            fileURLToPath(
              new URL('../src/features/editor/notebooks/widgets/frame-runtime.ts', import.meta.url),
            ),
          ],
          bundle: true,
          write: false,
          format: 'iife',
          minify: true,
          target: 'es2022',
          loader: { '.svg': 'text' },
          define: { 'define.amd': 'false', 'process.env.NODE_ENV': '"production"' },
          legalComments: 'inline',
          plugins: [
            {
              name: 'inline-widget-css',
              setup(builder) {
                builder.onLoad({ filter: /\.css$/ }, (args) => {
                  const css = inlineCss(args.path);
                  return {
                    contents: `const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.append(style);`,
                    loader: 'js',
                  };
                });
              },
            },
          ],
        });
        const widgetRoot = dirname(require.resolve('@jupyter-widgets/html-manager/package.json'));
        const icons = inlineCss(
          require.resolve('@fortawesome/fontawesome-free/css/all.min.css', { paths: [widgetRoot] }),
        );
        return (
          readFileSync(require.resolve('requirejs/require.js'), 'utf8') +
          `\n;(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(icons)};document.head.append(style)})();\n` +
          result.outputFiles[0]!.text
        );
      })();
      return `export default ${JSON.stringify(await pending)};`;
    },
  };
}
