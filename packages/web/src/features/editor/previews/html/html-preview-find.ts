import type { FindDirection, FindOptions, FindResult } from '../../../find/find-types';

export const HTML_PREVIEW_FIND_OPEN = 'puddle-preview-find-open';
export const HTML_PREVIEW_FIND_APPLY = 'puddle-preview-find-apply';
export const HTML_PREVIEW_FIND_RESULT = 'puddle-preview-find-result';
export const HTML_PREVIEW_FIND_CLEAR = 'puddle-preview-find-clear';

export type HtmlPreviewFindMessage =
  | { kind: typeof HTML_PREVIEW_FIND_OPEN; channel: string }
  | ({ kind: typeof HTML_PREVIEW_FIND_RESULT; channel: string } & FindResult);

/** Validate messages from one exact sandbox document and find capability. */
export function htmlPreviewFindMessage(
  event: Pick<MessageEvent<unknown>, 'source' | 'data'>,
  iframeWindow: MessageEventSource | null,
  channel: string,
): HtmlPreviewFindMessage | null {
  if (event.source !== iframeWindow || iframeWindow === null) return null;
  if (typeof event.data !== 'object' || event.data === null) return null;
  const data = event.data as Record<string, unknown>;
  if (data['channel'] !== channel) return null;
  if (data['kind'] === HTML_PREVIEW_FIND_OPEN) {
    return { kind: HTML_PREVIEW_FIND_OPEN, channel };
  }
  if (
    data['kind'] !== HTML_PREVIEW_FIND_RESULT ||
    typeof data['index'] !== 'number' ||
    !Number.isInteger(data['index']) ||
    data['index'] < -1 ||
    typeof data['count'] !== 'number' ||
    !Number.isInteger(data['count']) ||
    data['count'] < 0 ||
    (data['invalid'] !== undefined && typeof data['invalid'] !== 'boolean') ||
    (data['limited'] !== undefined && typeof data['limited'] !== 'boolean')
  ) {
    return null;
  }
  return {
    kind: HTML_PREVIEW_FIND_RESULT,
    channel,
    index: data['index'],
    count: data['count'],
    ...(data['invalid'] !== undefined ? { invalid: data['invalid'] } : {}),
    ...(data['limited'] !== undefined ? { limited: data['limited'] } : {}),
  } as HtmlPreviewFindMessage;
}

export function applyHtmlPreviewFind(
  iframeWindow: Pick<Window, 'postMessage'> | null,
  channel: string,
  query: string,
  options: FindOptions,
  direction: FindDirection,
): void {
  iframeWindow?.postMessage(
    { kind: HTML_PREVIEW_FIND_APPLY, channel, query, options, direction },
    '*',
  );
}

export function clearHtmlPreviewFind(
  iframeWindow: Pick<Window, 'postMessage'> | null,
  channel: string,
): void {
  iframeWindow?.postMessage({ kind: HTML_PREVIEW_FIND_CLEAR, channel }, '*');
}

/**
 * Search lives inside the opaque-origin iframe: the parent cannot inspect its
 * DOM, and granting `allow-same-origin` would let arbitrary HTML reach puddle's
 * token and storage. This capability-only bridge carries query state and a
 * result count, never credentials or document contents.
 */
export function htmlPreviewFindBridgeScript(channel: string): string {
  const encodedChannel = JSON.stringify(channel);
  const openKind = JSON.stringify(HTML_PREVIEW_FIND_OPEN);
  const applyKind = JSON.stringify(HTML_PREVIEW_FIND_APPLY);
  const resultKind = JSON.stringify(HTML_PREVIEW_FIND_RESULT);
  const clearKind = JSON.stringify(HTML_PREVIEW_FIND_CLEAR);
  return `(() => {
    const channel = ${encodedChannel};
    const openKind = ${openKind};
    const applyKind = ${applyKind};
    const resultKind = ${resultKind};
    const clearKind = ${clearKind};
    const matchName = 'puddle-find-match';
    const activeName = 'puddle-find-active';
    const limit = 1000;
    let signature = '';
    let ranges = [];
    let index = -1;
    let limited = false;

    const style = document.createElement('style');
    style.textContent =
      '::highlight(' + matchName + ') { background: Mark; color: MarkText; }' +
      '::highlight(' + activeName + ') { background: Highlight; color: HighlightText; }';
    (document.head || document.documentElement).appendChild(style);

    const clearHighlights = () => {
      CSS.highlights.delete(matchName);
      CSS.highlights.delete(activeName);
    };
    const clear = () => {
      signature = '';
      ranges = [];
      index = -1;
      limited = false;
      clearHighlights();
    };
    const report = (invalid = false) => {
      parent.postMessage({
        kind: resultKind,
        channel,
        index,
        count: ranges.length,
        invalid,
        limited,
      }, '*');
    };
    const textNodes = () => {
      const walker = document.createTreeWalker(document.body || document.documentElement,
        NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!node.textContent || (parent && parent.closest(
              'script, style, noscript, [hidden], [aria-hidden="true"]'
            ))) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
      const nodes = [];
      let text = '';
      let node;
      while (node = walker.nextNode()) {
        const value = node.textContent || '';
        const start = text.length;
        text += value;
        nodes.push({ node, start, end: text.length });
      }
      return { text, nodes };
    };
    const compile = (query, options) => {
      const slash = String.fromCharCode(92);
      const specials = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', slash]);
      let pattern = options.regex
        ? query
        : Array.from(query, (character) => specials.has(character) ? slash + character : character).join('');
      if (options.wholeWord) pattern = slash + 'b(?:' + pattern + ')' + slash + 'b';
      return new RegExp(pattern, options.caseSensitive ? 'g' : 'gi');
    };
    const rangeFor = (match, nodes) => {
      const first = nodes.find((entry) => entry.end > match.start);
      const last = nodes.findLast((entry) => entry.start < match.end);
      if (!first || !last) return null;
      const range = document.createRange();
      range.setStart(first.node, match.start - first.start);
      range.setEnd(last.node, match.end - last.start);
      return range;
    };
    const rebuild = (query, options) => {
      ranges = [];
      limited = false;
      index = -1;
      if (!query) return false;
      let matcher;
      try {
        matcher = compile(query, options);
      } catch {
        return true;
      }
      const content = textNodes();
      let match;
      while (match = matcher.exec(content.text)) {
        if (!match[0].length) {
          matcher.lastIndex++;
          continue;
        }
        if (ranges.length === limit) {
          limited = true;
          break;
        }
        const range = rangeFor(
          { start: match.index, end: match.index + match[0].length },
          content.nodes,
        );
        if (range) ranges.push(range);
      }
      index = ranges.length ? 0 : -1;
      return false;
    };
    const paint = () => {
      clearHighlights();
      if (!ranges.length) return;
      CSS.highlights.set(matchName, new Highlight(...ranges));
      const active = ranges[index];
      if (!active) return;
      CSS.highlights.set(activeName, new Highlight(active));
      const element = active.startContainer.parentElement;
      if (element) element.scrollIntoView({ block: 'center', inline: 'nearest' });
    };

    addEventListener('keydown', (event) => {
      const mac = /Mac|iPhone|iPad/.test(navigator.platform);
      const modifier = mac
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (event.key.toLowerCase() !== 'f' || !modifier || event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      parent.postMessage({ kind: openKind, channel }, '*');
    }, true);

    addEventListener('message', (event) => {
      const data = event.data;
      if (event.source !== parent || !data || data.channel !== channel) return;
      if (data.kind === clearKind) {
        clear();
        return;
      }
      if (data.kind !== applyKind || typeof data.query !== 'string' ||
          !data.options || typeof data.options !== 'object') return;
      const nextSignature = JSON.stringify([data.query, data.options]);
      let invalid = false;
      if (nextSignature !== signature || data.direction === 'reset') {
        signature = nextSignature;
        invalid = rebuild(data.query, data.options);
      } else if (ranges.length) {
        index = data.direction === 'previous'
          ? (index - 1 + ranges.length) % ranges.length
          : (index + 1) % ranges.length;
      }
      if (invalid) clearHighlights();
      else paint();
      report(invalid);
    });
  })();`;
}

export function appendHtmlPreviewFindBridge(doc: Document, channel: string): void {
  const script = doc.createElement('script');
  script.textContent = htmlPreviewFindBridgeScript(channel);
  (doc.body ?? doc.documentElement).appendChild(script);
}
