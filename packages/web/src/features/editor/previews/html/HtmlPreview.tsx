import { useEffect, useMemo, useRef, useState } from 'react';
import { useClientSettings } from '../../../../lib/settings/client-settings';
import { useFindControls } from '../../../find/use-find-controls';
import {
  applyHtmlPreviewScroll,
  createHtmlPreviewScrollChannel,
  htmlPreviewScrollReport,
  htmlPreviewSourceReveal,
} from './html-preview-scroll';
import {
  applyHtmlPreviewFind,
  clearHtmlPreviewFind,
  htmlPreviewFindMessage,
  HTML_PREVIEW_FIND_OPEN,
  HTML_PREVIEW_FIND_RESULT,
} from './html-preview-find';
import {
  previewScrollStore,
  previewViewPositions,
  type PreviewScrollTarget,
} from '../preview-scroll-store';
import { useViewStateKey } from '../../tabs/view-state-context';
import { countSourceLines } from '../source-anchor-map';
import { inlineWorktreeAssets } from './html-preview-document';
import { FindOverlay, editorLine, type TextPreviewProps } from '../preview-controls';

export function HtmlPreview({
  session,
  path,
  text,
  root,
  scrollDriver = false,
  scrollReceiver = false,
  scrollChannel = 'profile',
  focused = true,
  onRevealSource,
  mobile = false,
}: TextPreviewProps) {
  const viewKey = useViewStateKey('html', [session, root, path]);
  const [doc, setDoc] = useState<string | null>(null);
  // Resolved path → data-URI promise, per mount: an edit re-inlines the
  // document without re-fetching every asset.
  const assets = useRef(new Map<string, Promise<string | null>>());
  const fontSize = useClientSettings().editorFontSize;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [bridgeChannel] = useState(createHtmlPreviewScrollChannel);
  const [findChannel] = useState(createHtmlPreviewScrollChannel);
  const find = useFindControls({
    shortcutEnabled: focused,
    onFind: (query, options, direction) =>
      applyHtmlPreviewFind(
        iframeRef.current?.contentWindow ?? null,
        findChannel,
        query,
        options,
        direction,
      ),
    onClear: () => clearHtmlPreviewFind(iframeRef.current?.contentWindow ?? null, findChannel),
    onCloseFocus: () => iframeRef.current?.focus(),
  });
  const target = useMemo<PreviewScrollTarget>(
    () => ({ session, path, root }),
    [session, path, root],
  );
  const lineCount = useMemo(() => countSourceLines(text), [text]);

  useEffect(() => {
    let cancelled = false;
    void inlineWorktreeAssets(
      session,
      path,
      text,
      assets.current,
      fontSize,
      root,
      bridgeChannel,
      findChannel,
    ).then((html) => {
      if (!cancelled) setDoc(html);
    });
    return () => {
      cancelled = true;
    };
  }, [session, path, text, fontSize, root, bridgeChannel, findChannel, mobile]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = htmlPreviewFindMessage(
        event,
        iframeRef.current?.contentWindow ?? null,
        findChannel,
      );
      if (message?.kind === HTML_PREVIEW_FIND_OPEN) find.openFind();
      else if (message?.kind === HTML_PREVIEW_FIND_RESULT) find.setResult(message);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [find.openFind, find.setResult, findChannel]);

  useEffect(() => {
    if (!scrollReceiver) return;
    return previewScrollStore.subscribe(scrollChannel, target, (position) => {
      applyHtmlPreviewScroll(iframeRef.current?.contentWindow ?? null, bridgeChannel, position);
    });
  }, [scrollReceiver, scrollChannel, target, bridgeChannel]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const report = htmlPreviewScrollReport(
        event,
        iframeRef.current?.contentWindow ?? null,
        bridgeChannel,
      );
      if (report) {
        if (report.layout && (scrollReceiver || !report.scrolled)) {
          const current =
            (scrollReceiver ? previewScrollStore.get(scrollChannel, target) : undefined) ??
            previewViewPositions.get(viewKey);
          if (current) {
            applyHtmlPreviewScroll(
              iframeRef.current?.contentWindow ?? null,
              bridgeChannel,
              current,
            );
          }
          if (scrollDriver) {
            const position = current ?? report;
            previewScrollStore.publish(scrollChannel, target, position.ratio, position.sourceLine);
          }
        } else {
          previewViewPositions.set(viewKey, {
            ratio: report.ratio,
            sourceLine: report.sourceLine,
            revision: 0,
          });
          if (scrollDriver)
            previewScrollStore.publish(scrollChannel, target, report.ratio, report.sourceLine);
        }
      }
      const reveal = onRevealSource
        ? htmlPreviewSourceReveal(event, iframeRef.current?.contentWindow ?? null, bridgeChannel)
        : null;
      if (reveal) onRevealSource?.({ line: editorLine(reveal.line, lineCount) });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [
    scrollDriver,
    scrollReceiver,
    scrollChannel,
    target,
    bridgeChannel,
    onRevealSource,
    lineCount,
    viewKey,
  ]);

  if (doc === null) return null; // first inline pass; later passes keep the old doc up
  return (
    <div className="relative size-full bg-paper">
      <iframe
        ref={iframeRef}
        // allow-scripts WITHOUT allow-same-origin: the document runs on a null
        // origin — it cannot read the app's cookies, storage, or daemon token.
        // That null origin is also why assets are baked in as data URIs: it
        // cannot load this origin's blob URLs, and giving it a tokened URL
        // would hand the daemon token to arbitrary document scripts.
        sandbox="allow-scripts"
        key={mobile ? doc : undefined}
        src={mobile ? '/preview.html' : undefined}
        srcDoc={mobile ? undefined : doc}
        title={path}
        className="size-full bg-paper"
        onLoad={() => {
          const frame = iframeRef.current;
          if (mobile && frame && !frame.dataset.delivered) {
            frame.dataset.delivered = 'true';
            frame.contentWindow?.postMessage({ kind: 'puddle-preview-document', html: doc }, '*');
          }
          {
            const current =
              (scrollReceiver ? previewScrollStore.get(scrollChannel, target) : undefined) ??
              previewViewPositions.get(viewKey);
            if (current) {
              applyHtmlPreviewScroll(
                iframeRef.current?.contentWindow ?? null,
                bridgeChannel,
                current,
              );
            }
          }
          find.refresh();
        }}
      />
      <FindOverlay controls={find} />
    </div>
  );
}
