import { describe, expect, it, vi } from 'vitest';
import {
  applyHtmlPreviewScroll,
  HTML_PREVIEW_SCROLL_APPLY,
  HTML_PREVIEW_SCROLL_REPORT,
  HTML_PREVIEW_SOURCE_REVEAL,
  htmlPreviewScrollBridgeScript,
  htmlPreviewScrollReport,
  htmlPreviewSourceReveal,
} from '../../../../src/features/editor/previews/html/html-preview-scroll';

describe('sandboxed HTML preview scroll bridge', () => {
  const channel = 'mount-channel';
  const iframeWindow = {} as MessageEventSource;
  const event = (data: unknown, source: MessageEventSource | null = iframeWindow) => ({
    data,
    source,
  });

  it('accepts only the current iframe, channel, kind, and finite ratio', () => {
    const valid = {
      kind: HTML_PREVIEW_SCROLL_REPORT,
      channel,
      ratio: 0.4,
      sourceLine: 12.5,
      layout: true,
      scrolled: false,
    };
    expect(htmlPreviewScrollReport(event(valid), iframeWindow, channel)).toEqual(valid);
    expect(
      htmlPreviewScrollReport(event(valid, {} as MessageEventSource), iframeWindow, channel),
    ).toBeNull();
    expect(
      htmlPreviewScrollReport(event({ ...valid, channel: 'stale' }), iframeWindow, channel),
    ).toBeNull();
    expect(
      htmlPreviewScrollReport(
        event({ ...valid, kind: HTML_PREVIEW_SCROLL_APPLY }),
        iframeWindow,
        channel,
      ),
    ).toBeNull();
    expect(
      htmlPreviewScrollReport(event({ ...valid, ratio: Number.NaN }), iframeWindow, channel),
    ).toBeNull();
    expect(
      htmlPreviewScrollReport(event({ ...valid, layout: 'yes' }), iframeWindow, channel),
    ).toBeNull();
    expect(
      htmlPreviewScrollReport(event({ ...valid, sourceLine: Number.NaN }), iframeWindow, channel),
    ).toBeNull();
  });

  it('posts only a clamped local semantic apply message', () => {
    const postMessage = vi.fn();
    applyHtmlPreviewScroll({ postMessage } as never, channel, { ratio: 2, sourceLine: 42 });
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      { kind: HTML_PREVIEW_SCROLL_APPLY, channel, ratio: 1, sourceLine: 42 },
      '*',
    );
  });

  it('validates source-reveal clicks on the same iframe capability', () => {
    const valid = { kind: HTML_PREVIEW_SOURCE_REVEAL, channel, line: 8.75 };
    expect(htmlPreviewSourceReveal(event(valid), iframeWindow, channel)).toEqual(valid);
    expect(
      htmlPreviewSourceReveal(event(valid, {} as MessageEventSource), iframeWindow, channel),
    ).toBeNull();
    expect(
      htmlPreviewSourceReveal(event({ ...valid, line: Infinity }), iframeWindow, channel),
    ).toBeNull();
  });

  it('injects frame-limited reporting, reflow observation, and parent-only apply handling', () => {
    const script = htmlPreviewScrollBridgeScript(channel);
    expect(script).toContain('requestAnimationFrame');
    expect(script).toContain('ResizeObserver');
    expect(script).toContain('MutationObserver');
    expect(script).toContain('event.source !== parent');
    expect(script).toContain(JSON.stringify(channel));
    expect(script).toContain(HTML_PREVIEW_SCROLL_REPORT);
    expect(script).toContain(HTML_PREVIEW_SCROLL_APPLY);
    expect(script).toContain(HTML_PREVIEW_SOURCE_REVEAL);
    expect(script).toContain('data-puddle-source-line');
    expect(script).not.toContain('token');
  });
});
