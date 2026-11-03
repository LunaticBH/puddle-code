import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import DOMPurify from 'dompurify';
import { Copy, Download } from 'lucide-react';
import { toast } from 'sonner';
import { markdownToHtml } from '../previews/markdown/markdown';
import { notebookText, notebookOutputText, type NotebookOutput } from './notebook-format';
import { currentTheme, onThemeChange } from '../../../lib/appearance/theme';
import { renderMermaidDiagrams } from '../previews/markdown/markdown-mermaid';
import { usePreviewAssets } from '../previews/use-preview-assets';
import { resolvePreviewAsset } from '../previews/preview-kind';
import { NotebookRenderingContext } from './NotebookRenderingContext';
import { downloadBlob } from '../../../lib/download-blob';
const NotebookWidget = lazy(() => import('./widgets/NotebookWidget'));

function withAttachments(text: string, attachments: unknown): string {
  if (!attachments || typeof attachments !== 'object') return text;
  return text.replace(/attachment:([^\s"')>]+)/g, (original, name: string) => {
    try {
      const bundle = (attachments as Record<string, unknown>)[decodeURIComponent(name)];
      if (!bundle || typeof bundle !== 'object') return original;
      for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
        const data = notebookText((bundle as Record<string, unknown>)[mime]).replace(/\s/g, '');
        if (data && /^[A-Za-z0-9+/]*={0,2}$/.test(data)) return `data:${mime};base64,${data}`;
      }
    } catch {
      /* An invalid attachment URI stays inert. */
    }
    return original;
  });
}

export function NotebookHtml({
  text,
  markdown = false,
  attachments,
}: {
  text: string;
  markdown?: boolean;
  attachments?: unknown;
}) {
  const source = useContext(NotebookRenderingContext);
  const body = useRef<HTMLDivElement>(null);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const theme = useSyncExternalStore(onThemeChange, currentTheme, currentTheme);
  const html = useMemo(
    () =>
      DOMPurify.sanitize(markdown ? markdownToHtml(withAttachments(text, attachments), id) : text, {
        FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button'],
        ...(markdown ? {} : { FORBID_ATTR: ['style'] }),
      }),
    [text, markdown, attachments, id],
  );
  const rendered = useMemo(() => ({ __html: html }), [html, theme]);
  usePreviewAssets(body, html, source?.session ?? '', source?.path ?? '', source?.root);
  useEffect(() => {
    const abort = new AbortController();
    if (body.current && markdown) void renderMermaidDiagrams(body.current, theme, abort.signal);
    return () => abort.abort();
  }, [html, theme, markdown]);
  return (
    <div
      ref={body}
      className="md-preview overflow-x-auto text-sm"
      dangerouslySetInnerHTML={rendered}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest('a');
        if (!anchor) return;
        const href = anchor.getAttribute('href') ?? '';
        if (/^https?:/i.test(href)) {
          event.preventDefault();
          window.open(href, '_blank', 'noopener,noreferrer');
          return;
        }
        if (href.startsWith('#')) {
          event.preventDefault();
          try {
            body.current
              ?.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`)
              ?.scrollIntoView({ block: 'nearest' });
          } catch {
            /* Invalid fragment. */
          }
          return;
        }
        const path = source ? resolvePreviewAsset(source.path, href) : null;
        if (path) {
          event.preventDefault();
          if (event.metaKey || event.ctrlKey) source?.onOpenFile?.(path);
        }
      }}
    />
  );
}

const control = 'cursor-pointer rounded-sm p-1 text-fg-muted hover:bg-surface hover:text-fg';
export function NotebookOutputView({ output }: { output: NotebookOutput }) {
  let image: { src: string; blob: Blob; extension: string } | null = null;
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    const encoded = notebookText(output.data?.[mime]).replace(/\s/g, '');
    if (encoded && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      try {
        image = {
          src: `data:${mime};base64,${encoded}`,
          blob: new Blob([Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))], {
            type: mime,
          }),
          extension: mime.split('/')[1]!,
        };
      } catch {
        /* Fall back to the next representation. */
      }
      if (image) break;
    }
  }
  const svg = notebookText(output.data?.['image/svg+xml']);
  const safeSvg = svg
    ? DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['style', 'foreignObject', 'image', 'use'],
        FORBID_ATTR: ['style', 'href', 'xlink:href'],
      })
    : '';
  const html = notebookText(output.data?.['text/html']);
  const markdown = notebookText(output.data?.['text/markdown']);
  const json = output.data?.['application/json'];
  const widget = output.data?.['application/vnd.jupyter.widget-view+json'];
  const widgetId =
    widget &&
    typeof widget === 'object' &&
    'model_id' in widget &&
    typeof widget.model_id === 'string'
      ? widget.model_id
      : null;
  const text =
    notebookOutputText(output) ||
    (json !== undefined ? JSON.stringify(json, null, 2) : '') ||
    'This output format cannot be displayed.';
  return (
    <div className="group/output relative">
      <div className="absolute right-1 top-0 z-10 flex gap-1 bg-ground opacity-0 group-hover/output:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
        <button
          type="button"
          title="Copy output"
          aria-label="Copy output"
          className={control}
          onClick={() => {
            void navigator.clipboard
              .writeText(text)
              .catch(() => toast.error('Could not copy output'));
          }}
        >
          <Copy className="size-3.5" />
        </button>
        {(image || safeSvg) && (
          <button
            type="button"
            title="Save image"
            aria-label="Save image"
            className={control}
            onClick={() =>
              downloadBlob(
                image?.blob ?? new Blob([safeSvg], { type: 'image/svg+xml' }),
                `notebook-output.${image?.extension ?? 'svg'}`,
              )
            }
          >
            <Download className="size-3.5" />
          </button>
        )}
      </div>
      {widgetId ? (
        <Suspense fallback={<p className="text-xs text-fg-muted">Loading widget…</p>}>
          <NotebookWidget modelId={widgetId} fallback={notebookOutputText(output)} />
        </Suspense>
      ) : image ? (
        <img src={image.src} alt="Notebook output" className="max-w-full" />
      ) : safeSvg ? (
        <div dangerouslySetInnerHTML={{ __html: safeSvg }} />
      ) : html ? (
        <NotebookHtml text={html} />
      ) : markdown ? (
        <NotebookHtml text={markdown} markdown />
      ) : (
        <pre
          className={`overflow-x-auto whitespace-pre-wrap font-mono text-sm ${output.output_type === 'error' ? 'text-danger' : 'text-fg-secondary'}`}
        >
          {text}
        </pre>
      )}
    </div>
  );
}
