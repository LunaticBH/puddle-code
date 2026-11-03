import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Code, Eye } from 'lucide-react';
import type { ThemeName } from '../../../lib/appearance/theme';
import { cn } from '../../../lib/utils';
import type { TerminalRichBlock as RichBlock } from './rich-output-buffer';

export interface RichBlockBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A fitted DOM layer; source cells, PTY geometry and input remain xterm-owned. */
export function TerminalRichBlock({
  block,
  box,
  theme,
  fontSize,
}: {
  block: RichBlock;
  box: RichBlockBox;
  theme: ThemeName;
  fontSize: number;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [sourceVisible, setSourceVisible] = useState(false);
  const { source, kind, display } = block;

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const abort = new AbortController();
    setReady(false);
    setError('');
    body.replaceChildren();
    const render = async () => {
      if (kind === 'mermaid') {
        const { renderMermaidDiagrams } =
          await import('../../editor/previews/markdown/markdown-mermaid');
        if (abort.signal.aborted) return;
        const diagram = document.createElement('div');
        diagram.setAttribute('data-puddle-mermaid', '');
        diagram.textContent = source;
        body.append(diagram);
        await renderMermaidDiagrams(body, theme, abort.signal, true);
        if (abort.signal.aborted) return;
        const svg = diagram.querySelector('svg');
        if (!svg) throw new Error('Unable to render Mermaid diagram');
        // Mermaid normally fits to a Markdown column. Here its natural viewBox
        // is measured once and fitted to the terminal cells by the observer.
        const bounds = svg.viewBox.baseVal;
        svg.style.maxWidth = 'none';
        svg.style.width = `${bounds.width}px`;
        svg.style.height = `${bounds.height}px`;
      } else {
        const [{ renderMathHtml }, { default: DOMPurify }] = await Promise.all([
          import('../../editor/previews/markdown/math'),
          import('dompurify'),
          import('katex/dist/katex.min.css'),
        ]);
        if (abort.signal.aborted) return;
        body.innerHTML = DOMPurify.sanitize(renderMathHtml(source, display));
        if (body.querySelector('.katex-error')) throw new Error('Unable to render LaTeX');
      }
      if (!abort.signal.aborted) setReady(true);
    };
    void render().catch((reason: unknown) => {
      if (!abort.signal.aborted)
        setError(reason instanceof Error ? reason.message : 'Unable to render output');
    });
    return () => abort.abort();
  }, [source, kind, display, theme]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const frame = frameRef.current;
    if (!body || !frame) return;
    const fit = () => {
      const width = body.scrollWidth;
      const height = body.scrollHeight;
      if (!width || !height) return;
      const scale = Math.min(1, frame.clientWidth / width, frame.clientHeight / height);
      body.style.transform = `scale(${scale})`;
      body.style.left = `${display ? (frame.clientWidth - width * scale) / 2 : 0}px`;
      body.style.top = `${(frame.clientHeight - height * scale) / 2}px`;
    };
    const observer = new ResizeObserver(fit);
    observer.observe(body);
    observer.observe(frame);
    fit();
    return () => observer.disconnect();
  }, [display, ready]);

  const rendered = ready && !sourceVisible;
  const label = rendered
    ? 'Show terminal source'
    : `Render ${kind === 'math' ? 'LaTeX' : 'Mermaid'}`;
  return (
    <div
      ref={frameRef}
      className={cn('absolute overflow-hidden', rendered && 'bg-ground')}
      style={{ ...box, fontSize }}
      data-terminal-rich-block={kind}
      data-rendered={rendered}
    >
      <div
        ref={bodyRef}
        className={cn('absolute w-max origin-top-left text-fg', !rendered && 'invisible')}
        aria-hidden={!rendered}
      />
      <button
        type="button"
        aria-label={label}
        title={error || label}
        style={{ top: Math.max(0, -box.top) }}
        disabled={!ready}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setSourceVisible((value) => !value);
        }}
        className="pointer-events-auto absolute right-0 top-0 rounded-sm bg-ground p-0.5 text-fg-muted opacity-0 transition-opacity hover:text-fg focus:opacity-100 group-hover/terminal:opacity-100 pointer-coarse:opacity-100"
      >
        {rendered ? <Code className="size-3" /> : <Eye className="size-3" />}
      </button>
    </div>
  );
}
