import {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';
import DOMPurify from 'dompurify';
import { useClientSettings } from '../../../../lib/settings/client-settings';
import { currentTheme, onThemeChange } from '../../../../lib/appearance/theme';
import { DomFindController } from '../../../find/dom-find';
import { EMPTY_FIND_RESULT } from '../../../find/find-types';
import { useFindControls } from '../../../find/use-find-controls';
import { markdownToHtml } from './markdown';
import { renderMermaidDiagrams } from './markdown-mermaid';
import { resolvePreviewAsset } from '../preview-kind';
import { bindPreviewScrollElement } from '../preview-scroll-store';
import { useViewStateKey } from '../../tabs/view-state-context';
import { countSourceLines, measureSourceAnchors, sourceLineAtOffset } from '../source-anchor-map';
import { usePreviewAssets } from '../use-preview-assets';
import { FindOverlay, editorLine, type TextPreviewProps } from '../preview-controls';

/** External links open a new tab; worktree links navigate via ctrl/⌘-click below. */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && /^https?:/i.test(node.getAttribute('href') ?? '')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function MarkdownPreview({
  session,
  path,
  text,
  root,
  scrollDriver = false,
  scrollReceiver = false,
  scrollChannel = 'profile',
  focused = true,
  onRevealSource,
  onOpenFile,
  mobile = false,
}: TextPreviewProps) {
  const viewKey = useViewStateKey('markdown', [session, root, path]);
  const documentId = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const theme = useSyncExternalStore(
    (onChange) => onThemeChange(onChange),
    currentTheme,
    currentTheme,
  );
  const html = useMemo(
    () => DOMPurify.sanitize(markdownToHtml(text, documentId)),
    [text, documentId],
  );
  const lineCount = useMemo(() => countSourceLines(text), [text]);
  // React compares dangerouslySetInnerHTML by object identity before writing
  // innerHTML. Keep that object stable across find-result state updates: a
  // redundant rewrite replaces every text node, detaching the CSS Highlight
  // ranges immediately after they are painted and leaving navigation with
  // detached elements that cannot scroll into view.
  const renderedHtml = useMemo(() => ({ __html: html }), [html, theme]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const findControllerRef = useRef<DomFindController | null>(null);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const controller = new DomFindController(body);
    findControllerRef.current = controller;
    return () => {
      controller.dispose();
      findControllerRef.current = null;
    };
  }, []);

  const find = useFindControls({
    shortcutEnabled: focused,
    onFind: (query, options, direction) =>
      findControllerRef.current?.find(query, options, direction) ?? EMPTY_FIND_RESULT,
    onClear: () => findControllerRef.current?.clear(),
    onCloseFocus: () => scrollerRef.current?.focus({ preventScroll: true }),
  });

  // React replaces the rendered prose when the shared buffer changes. Rebuild
  // the ranges against the new text instead of retaining detached Range nodes.
  useEffect(() => find.refresh(), [html, theme, find.refresh]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const abort = new AbortController();
    void renderMermaidDiagrams(body, theme, abort.signal).then(() => {
      // Mermaid replaces source text with SVG labels after the ordinary HTML
      // render, so active rendered-view searches need fresh DOM ranges.
      if (!abort.signal.aborted) find.refresh();
    });
    return () => abort.abort();
  }, [html, theme, find.refresh]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const body = bodyRef.current;
    if (!scroller || !body) return;
    return bindPreviewScrollElement(scroller, {
      viewKey,
      channel: scrollChannel,
      target: { session, path, root },
      driver: scrollDriver,
      receiver: scrollReceiver,
      resizeElements: [scroller, body],
      sourceAnchors: () => measureSourceAnchors(scroller, body, lineCount),
    });
  }, [html, lineCount, session, path, root, scrollChannel, scrollDriver, scrollReceiver, viewKey]);

  usePreviewAssets(bodyRef, html, session, path, root);

  // Desktop uses ctrl/⌘-click; mobile uses a tap to follow worktree links.
  // Fragments scroll in place and http(s) links retain target=_blank.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (anchor) {
      const href = anchor.getAttribute('href') ?? '';
      if (/^https?:/i.test(href)) return;
      e.preventDefault();
      if (href.startsWith('#')) {
        const id = decodeFragment(href);
        const target = id
          ? bodyRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
          : null;
        target?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (!mobile && !e.metaKey && !e.ctrlKey) return;
      const resolved = resolvePreviewAsset(path, href);
      if (!resolved) return;
      // Inside an external (rooted) preview the link resolves against the SAME
      // root — a `file` tab would resolve it against the worktree and open a
      // different file, or none.
      onOpenFile?.(resolved);
      return;
    }
    if ((!e.metaKey && !e.ctrlKey) || !onRevealSource) return;
    const scroller = scrollerRef.current;
    const body = bodyRef.current;
    if (!scroller || !body) return;
    const offset = e.clientY - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const sourceLine = sourceLineAtOffset(measureSourceAnchors(scroller, body, lineCount), offset);
    if (sourceLine === null) return;
    e.preventDefault();
    onRevealSource({ line: editorLine(sourceLine, lineCount) });
  };

  // The preview is the editor's rendered view, so it follows the editor font
  // size (Settings → Appearance); the md-preview scale is em-based, so
  // headings, code, and spacing all track the base.
  const fontSize = useClientSettings().editorFontSize;
  return (
    <div className="relative size-full bg-ground">
      <div
        ref={scrollerRef}
        tabIndex={-1}
        className="h-full overflow-auto overscroll-contain outline-none"
      >
        <div
          ref={bodyRef}
          onClick={onClick}
          style={{ fontSize }}
          className="md-preview mx-auto max-w-3xl px-6 py-5 text-fg-secondary"
          // Sanitised above — DOMPurify with the default profile, no raw input.
          dangerouslySetInnerHTML={renderedHtml}
        />
      </div>
      <FindOverlay controls={find} />
    </div>
  );
}

function decodeFragment(href: string): string | null {
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return null;
  }
}
