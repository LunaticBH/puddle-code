import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindMonacoPreviewScroll,
  monacoScrollTopForSourceLine,
  sourceLineAtMonacoScrollTop,
} from '../../../src/features/editor/previews/monaco-preview-scroll';
import {
  bindPreviewScrollElement,
  createAnimationFramePublisher,
  normalisedScrollRatio,
  PreviewScrollStore,
  scrollTopForRatio,
} from '../../../src/features/editor/previews/preview-scroll-store';

const target = { session: 'session-1', path: 'README.md' };

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let resizeCallbacks: ResizeObserverCallback[];

function flushFrames(): void {
  const queued = [...frames.values()];
  frames.clear();
  for (const callback of queued) callback(0);
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  resizeCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('proportional scroll maths', () => {
  it('clamps empty, short, over-scrolled, and resized documents', () => {
    expect(normalisedScrollRatio(0, 0, 0)).toBe(0);
    expect(normalisedScrollRatio(0, 80, 100)).toBe(0);
    expect(normalisedScrollRatio(250, 600, 100)).toBe(0.5);
    expect(normalisedScrollRatio(900, 600, 100)).toBe(1);
    expect(normalisedScrollRatio(-20, 600, 100)).toBe(0);
    expect(scrollTopForRatio(0.5, 600, 100)).toBe(250);
    expect(scrollTopForRatio(0.5, 1_000, 200)).toBe(400);
    expect(scrollTopForRatio(1, 80, 100)).toBe(0);
  });

  it('coalesces repeated publications and cancels a pending frame', () => {
    const publish = vi.fn();
    const publisher = createAnimationFramePublisher(publish);
    publisher.schedule();
    publisher.schedule();
    expect(frames.size).toBe(1);
    flushFrames();
    expect(publish).toHaveBeenCalledTimes(1);
    publisher.schedule();
    publisher.dispose();
    flushFrames();
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('PreviewScrollStore', () => {
  it('scopes, replays, switches targets, includes root, and disposes cleanly', () => {
    const store = new PreviewScrollStore();
    const seen: number[] = [];
    store.publish('profile', target, 0.25);
    const dispose = store.subscribe('profile', target, (position) => seen.push(position.ratio));
    expect(seen).toEqual([0.25]);

    store.publish('project:p1', target, 0.5);
    store.publish('profile', { ...target, path: 'other.md' }, 0.6);
    store.publish('profile', { ...target, root: '/outside' }, 0.7);
    expect(seen).toEqual([0.25]);

    store.publish('profile', target, 0.75);
    expect(seen).toEqual([0.25, 0.75]);
    dispose();
    store.publish('profile', target, 1);
    expect(seen).toEqual([0.25, 0.75]);
    expect(store.get('profile', { ...target, root: '/outside' })?.ratio).toBe(0.7);
    expect(store.get('profile', target)?.ratio).toBe(1);
    expect(store.get('profile', target)?.sourceLine).toBeNull();
  });

  it('retains a finite semantic line beside the ratio', () => {
    const store = new PreviewScrollStore();
    store.publish('profile', target, 0.4, 18.5);
    expect(store.get('profile', target)).toMatchObject({ ratio: 0.4, sourceLine: 18.5 });
    store.publish('profile', target, 0.4, Number.NaN);
    expect(store.get('profile', target)?.sourceLine).toBeNull();
  });
});

class FakeScroller {
  scrollTop = 0;
  scrollHeight = 600;
  clientHeight = 100;
  readonly listeners = new Set<EventListener>();

  addEventListener(_type: 'scroll', listener: EventListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'scroll', listener: EventListener): void {
    this.listeners.delete(listener);
  }

  scroll(): void {
    for (const listener of this.listeners) listener(new Event('scroll'));
  }
}

describe('Markdown scroll binding', () => {
  it('restores a tab before publishing and saves a last scroll before its frame', () => {
    const store = new PreviewScrollStore();
    const binding = {
      viewKey: 'returning-markdown-tab',
      channel: 'workspace',
      target,
      driver: true,
      receiver: false,
      store,
    };
    const first = new FakeScroller();
    const close = bindPreviewScrollElement(first, binding);
    first.scrollTop = 250;
    first.scroll();
    close(); // The queued publication has not run yet.
    const returned = new FakeScroller();
    const reports: number[] = [];
    const unsubscribe = store.subscribe('workspace', target, (position) =>
      reports.push(position.ratio),
    );
    const closeReturned = bindPreviewScrollElement(returned, binding);
    expect(returned.scrollTop).toBe(250);
    flushFrames();
    expect(reports.every((ratio) => ratio === 0.5)).toBe(true);
    closeReturned();
    unsubscribe();
  });

  it('reports from a driver and applies/reflows without receiver feedback', () => {
    const store = new PreviewScrollStore();
    const driver = new FakeScroller();
    driver.scrollTop = 250;
    const unbindDriver = bindPreviewScrollElement(driver, {
      channel: 'profile',
      target,
      driver: true,
      receiver: false,
      resizeElements: [{} as Element],
      store,
    });
    flushFrames();
    expect(store.get('profile', target)?.ratio).toBe(0.5);
    unbindDriver();

    const receiver = new FakeScroller();
    const unbindReceiver = bindPreviewScrollElement(receiver, {
      channel: 'profile',
      target,
      driver: false,
      receiver: true,
      resizeElements: [{} as Element],
      store,
    });
    expect(receiver.scrollTop).toBe(250);
    const revision = store.get('profile', target)?.revision;
    receiver.scrollTop = 100;
    receiver.scroll();
    expect(store.get('profile', target)?.revision).toBe(revision);

    receiver.scrollHeight = 1_000;
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
    expect(receiver.scrollTop).toBe(450);
    unbindReceiver();
  });

  it('uses source anchors instead of equal-height progress after reflow', () => {
    const store = new PreviewScrollStore();
    const driver = new FakeScroller();
    driver.scrollTop = 250;
    const unbindDriver = bindPreviewScrollElement(driver, {
      channel: 'profile',
      target,
      driver: true,
      receiver: false,
      sourceAnchors: () => [
        { line: 1, offset: 0 },
        { line: 50, offset: 250 },
        { line: 100, offset: 600 },
      ],
      store,
    });
    flushFrames();
    expect(store.get('profile', target)?.sourceLine).toBe(50);
    unbindDriver();

    const receiver = new FakeScroller();
    receiver.scrollHeight = 1_000;
    const unbindReceiver = bindPreviewScrollElement(receiver, {
      channel: 'profile',
      target,
      driver: false,
      receiver: true,
      sourceAnchors: () => [
        { line: 1, offset: 0 },
        { line: 50, offset: 600 },
        { line: 100, offset: 1_000 },
      ],
      store,
    });
    expect(receiver.scrollTop).toBe(600); // ratio-only would be 450
    unbindReceiver();
  });
});

describe('Monaco scroll binding', () => {
  it('keeps fractional progress through a wrapped final source line', () => {
    const editor = {
      getModel: () => ({ getLineCount: () => 1 }),
      getTopForLineNumber: () => 0,
      getScrollHeight: () => 400,
    };
    expect(sourceLineAtMonacoScrollTop(editor as never, 200)).toBe(1.5);
    expect(monacoScrollTopForSourceLine(editor as never, 1.5)).toBe(200);
  });

  it('publishes driver changes and applies receiver changes immediately', () => {
    const store = new PreviewScrollStore();
    const listeners = {
      scroll: new Set<() => void>(),
      model: new Set<() => void>(),
      modelContent: new Set<() => void>(),
      layout: new Set<() => void>(),
      contentSize: new Set<() => void>(),
    };
    let scrollTop = 250;
    let scrollHeight = 600;
    let viewportHeight = 100;
    const setScrollTop = vi.fn((value: number) => {
      scrollTop = value;
    });
    const register = (set: Set<() => void>, callback: () => void) => {
      set.add(callback);
      return { dispose: () => set.delete(callback) };
    };
    const editor = {
      getScrollTop: () => scrollTop,
      getScrollHeight: () => scrollHeight,
      getModel: () => ({ getLineCount: () => 101 }),
      getTopForLineNumber: (line: number) => (line - 1) * 5,
      getLayoutInfo: () => ({ height: viewportHeight }),
      setScrollTop,
      onDidScrollChange: (callback: () => void) => register(listeners.scroll, callback),
      onDidChangeModel: (callback: () => void) => register(listeners.model, callback),
      onDidChangeModelContent: (callback: () => void) => register(listeners.modelContent, callback),
      onDidLayoutChange: (callback: () => void) => register(listeners.layout, callback),
      onDidContentSizeChange: (callback: () => void) => register(listeners.contentSize, callback),
    };

    const unbindDriver = bindMonacoPreviewScroll(
      editor as never,
      { channel: 'profile', target, driver: true, receiver: false, store },
      1 as never,
    );
    flushFrames();
    expect(store.get('profile', target)?.ratio).toBe(0.5);
    expect(store.get('profile', target)?.sourceLine).toBe(51);
    scrollTop = 500;
    for (const listener of listeners.scroll) listener();
    flushFrames();
    expect(store.get('profile', target)?.ratio).toBe(1);
    unbindDriver();

    store.publish('profile', target, 0.5, null);
    scrollHeight = 1_000;
    viewportHeight = 200;
    const unbindReceiver = bindMonacoPreviewScroll(
      editor as never,
      { channel: 'profile', target, driver: false, receiver: true, store },
      1 as never,
    );
    expect(setScrollTop).toHaveBeenLastCalledWith(400, 1);
    expect(listeners.scroll.size).toBe(0);
    scrollHeight = 1_200;
    for (const listener of listeners.layout) listener();
    expect(setScrollTop).toHaveBeenLastCalledWith(500, 1);
    unbindReceiver();
  });
});
