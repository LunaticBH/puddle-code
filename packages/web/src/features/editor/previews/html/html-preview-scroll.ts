import { clampScrollRatio, type PreviewScrollPosition } from '../preview-scroll-store';
import {
  SOURCE_END_LINE_ATTRIBUTE,
  SOURCE_LINE_ATTRIBUTE,
  SOURCE_LINE_COUNT_ATTRIBUTE,
} from '../source-anchor-map';

export const HTML_PREVIEW_SCROLL_REPORT = 'puddle-preview-scroll-report';
export const HTML_PREVIEW_SCROLL_APPLY = 'puddle-preview-scroll-apply';
export const HTML_PREVIEW_SOURCE_REVEAL = 'puddle-preview-source-reveal';

export interface HtmlPreviewScrollReport {
  kind: typeof HTML_PREVIEW_SCROLL_REPORT;
  channel: string;
  ratio: number;
  sourceLine: number | null;
  /** Load/resize/mutation report: a locked parent should reapply after reflow. */
  layout: boolean;
  /** A scroll can share a frame with load/resize; do not discard that movement. */
  scrolled: boolean;
}

export interface HtmlPreviewSourceReveal {
  kind: typeof HTML_PREVIEW_SOURCE_REVEAL;
  channel: string;
  line: number;
}

/** A fresh, unguessable channel for one mounted sandboxed preview. */
export function createHtmlPreviewScrollChannel(): string {
  return crypto.randomUUID();
}

function messageRecord(
  event: Pick<MessageEvent<unknown>, 'source' | 'data'>,
  iframeWindow: MessageEventSource | null,
  channel: string,
): Record<string, unknown> | null {
  if (event.source !== iframeWindow || iframeWindow === null) return null;
  if (typeof event.data !== 'object' || event.data === null) return null;
  const data = event.data as Record<string, unknown>;
  return data['channel'] === channel ? data : null;
}

/**
 * Validate a null-origin iframe message by capability: exact content window,
 * local channel, known kind, and finite payload. `event.origin` is
 * intentionally irrelevant because a sandbox without allow-same-origin has
 * the opaque `null` origin (SPEC §8).
 */
export function htmlPreviewScrollReport(
  event: Pick<MessageEvent<unknown>, 'source' | 'data'>,
  iframeWindow: MessageEventSource | null,
  channel: string,
): HtmlPreviewScrollReport | null {
  const data = messageRecord(event, iframeWindow, channel);
  if (
    !data ||
    data['kind'] !== HTML_PREVIEW_SCROLL_REPORT ||
    typeof data['ratio'] !== 'number' ||
    !Number.isFinite(data['ratio']) ||
    (data['sourceLine'] !== null &&
      (typeof data['sourceLine'] !== 'number' || !Number.isFinite(data['sourceLine']))) ||
    typeof data['layout'] !== 'boolean' ||
    typeof data['scrolled'] !== 'boolean'
  ) {
    return null;
  }
  return {
    kind: HTML_PREVIEW_SCROLL_REPORT,
    channel,
    ratio: clampScrollRatio(data['ratio']),
    sourceLine: data['sourceLine'] === null ? null : Math.max(1, data['sourceLine']),
    layout: data['layout'],
    scrolled: data['scrolled'],
  };
}

export function htmlPreviewSourceReveal(
  event: Pick<MessageEvent<unknown>, 'source' | 'data'>,
  iframeWindow: MessageEventSource | null,
  channel: string,
): HtmlPreviewSourceReveal | null {
  const data = messageRecord(event, iframeWindow, channel);
  if (
    !data ||
    data['kind'] !== HTML_PREVIEW_SOURCE_REVEAL ||
    typeof data['line'] !== 'number' ||
    !Number.isFinite(data['line'])
  ) {
    return null;
  }
  return { kind: HTML_PREVIEW_SOURCE_REVEAL, channel, line: Math.max(1, data['line']) };
}

/** Apply one semantic position to the current sandbox document. */
export function applyHtmlPreviewScroll(
  iframeWindow: Pick<Window, 'postMessage'> | null,
  channel: string,
  position: Pick<PreviewScrollPosition, 'ratio' | 'sourceLine'>,
): void {
  iframeWindow?.postMessage(
    {
      kind: HTML_PREVIEW_SCROLL_APPLY,
      channel,
      ratio: clampScrollRatio(position.ratio),
      sourceLine:
        position.sourceLine !== null && Number.isFinite(position.sourceLine)
          ? Math.max(1, position.sourceLine)
          : null,
    },
    '*',
  );
}

/**
 * The only bridge injected into arbitrary HTML. It carries no token and keeps
 * the iframe sandbox unchanged. Parser-authored line anchors are measured
 * against the live DOM; reporting is frame-coalesced and recalculated after
 * resize or mutation. Apply messages are parent/channel scoped.
 */
export function htmlPreviewScrollBridgeScript(channel: string): string {
  const encodedChannel = JSON.stringify(channel);
  const reportKind = JSON.stringify(HTML_PREVIEW_SCROLL_REPORT);
  const applyKind = JSON.stringify(HTML_PREVIEW_SCROLL_APPLY);
  const revealKind = JSON.stringify(HTML_PREVIEW_SOURCE_REVEAL);
  const lineAttribute = JSON.stringify(SOURCE_LINE_ATTRIBUTE);
  const endLineAttribute = JSON.stringify(SOURCE_END_LINE_ATTRIBUTE);
  const countAttribute = JSON.stringify(SOURCE_LINE_COUNT_ATTRIBUTE);
  return `(() => {
    const channel = ${encodedChannel};
    const reportKind = ${reportKind};
    const applyKind = ${applyKind};
    const revealKind = ${revealKind};
    const lineAttribute = ${lineAttribute};
    const endLineAttribute = ${endLineAttribute};
    const countAttribute = ${countAttribute};
    let frame = 0;
    let layoutChanged = false;
    let scrolled = false;
    let sourceAnchors = [];
    const scrolling = () => document.scrollingElement || document.documentElement;
    const clamp = (value, lower, upper) => Math.min(upper, Math.max(lower, value));
    const numberAttribute = (element, attribute) => {
      const value = Number(element.getAttribute(attribute));
      return Number.isFinite(value) && value >= 1 ? value : null;
    };
    const measureAnchors = () => {
      const root = scrolling();
      const lineCount = numberAttribute(document.documentElement, countAttribute);
      if (lineCount === null) {
        sourceAnchors = [];
        return;
      }
      const values = [{ line: 1, offset: 0 }];
      for (const element of document.querySelectorAll('[' + lineAttribute + ']')) {
        const line = numberAttribute(element, lineAttribute);
        if (line === null || line > lineCount + 1 || element.getClientRects().length === 0) continue;
        const rect = element.getBoundingClientRect();
        const top = rect.top + root.scrollTop;
        values.push({ line, offset: top });
        const endLine = numberAttribute(element, endLineAttribute);
        if (endLine !== null && endLine <= lineCount + 1 && endLine > line && rect.height > 0) {
          values.push({ line: endLine, offset: top + rect.height });
        }
      }
      values.push({ line: lineCount + 1, offset: root.scrollHeight });
      values.sort((a, b) => a.offset - b.offset || a.line - b.line);
      const result = [];
      for (const value of values) {
        const previous = result[result.length - 1];
        if (previous && (value.line <= previous.line || value.offset <= previous.offset)) continue;
        result.push(value);
      }
      sourceAnchors = result;
    };
    const interpolate = (value, lowerInput, upperInput, lowerOutput, upperOutput) => {
      if (upperInput <= lowerInput) return lowerOutput;
      const progress = clamp((value - lowerInput) / (upperInput - lowerInput), 0, 1);
      return lowerOutput + progress * (upperOutput - lowerOutput);
    };
    const mapped = (value, input, output) => {
      const values = sourceAnchors;
      if (!values.length) return null;
      if (value <= values[0][input]) return values[0][output];
      const last = values[values.length - 1];
      if (value >= last[input]) return last[output];
      let low = 0;
      let high = values.length - 1;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (values[middle][input] <= value) low = middle;
        else high = middle;
      }
      return interpolate(value, values[low][input], values[high][input],
        values[low][output], values[high][output]);
    };
    const report = () => {
      frame = 0;
      if (layoutChanged) measureAnchors();
      const root = scrolling();
      const ratio = clamp(root.scrollTop / Math.max(1, root.scrollHeight - innerHeight), 0, 1);
      const sourceLine = mapped(root.scrollTop, 'offset', 'line');
      parent.postMessage({ kind: reportKind, channel, ratio, sourceLine, layout: layoutChanged, scrolled }, '*');
      layoutChanged = false;
      scrolled = false;
    };
    const schedule = (layout = false) => {
      layoutChanged = layoutChanged || layout;
      if (!frame) frame = requestAnimationFrame(report);
    };
    addEventListener('scroll', () => { scrolled = true; schedule(false); }, { passive: true });
    addEventListener('load', () => schedule(true));
    const resizeObserver = new ResizeObserver(() => schedule(true));
    resizeObserver.observe(document.documentElement);
    if (document.body) resizeObserver.observe(document.body);
    const mutationObserver = new MutationObserver(() => schedule(true));
    mutationObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    addEventListener('click', (event) => {
      if ((!event.metaKey && !event.ctrlKey) || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && target.closest('a[href]')) return;
      if (layoutChanged) measureAnchors();
      const root = scrolling();
      const line = mapped(event.clientY + root.scrollTop, 'offset', 'line');
      if (line === null) return;
      event.preventDefault();
      event.stopPropagation();
      parent.postMessage({ kind: revealKind, channel, line }, '*');
    }, true);
    addEventListener('message', (event) => {
      const data = event.data;
      if (event.source !== parent || !data || data.kind !== applyKind ||
          data.channel !== channel || typeof data.ratio !== 'number' ||
          !Number.isFinite(data.ratio) ||
          (data.sourceLine !== null &&
            (typeof data.sourceLine !== 'number' || !Number.isFinite(data.sourceLine)))) return;
      if (layoutChanged) measureAnchors();
      const root = scrolling();
      const ratio = clamp(data.ratio, 0, 1);
      const maximum = Math.max(0, root.scrollHeight - innerHeight);
      const semantic = ratio > 0 && ratio < 1 && data.sourceLine !== null
        ? mapped(data.sourceLine, 'line', 'offset')
        : null;
      scrollTo(0, semantic === null ? ratio * maximum : clamp(semantic, 0, maximum));
    });
    schedule(true);
  })();`;
}

/** Append the bridge after page content so its observers see the final body. */
export function appendHtmlPreviewScrollBridge(doc: Document, channel: string): void {
  const script = doc.createElement('script');
  script.textContent = htmlPreviewScrollBridgeScript(channel);
  (doc.body ?? doc.documentElement).appendChild(script);
}
