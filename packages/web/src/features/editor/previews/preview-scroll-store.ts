import { offsetAtSourceLine, sourceLineAtOffset, type SourceAnchor } from './source-anchor-map';
import { ViewStateStore } from '../tabs/view-state-store';

export interface PreviewScrollTarget {
  session: string;
  path: string;
  root?: string;
}

export interface PreviewScrollPosition {
  ratio: number;
  /** One-based semantic source line; null when a surface has no usable map. */
  sourceLine: number | null;
  revision: number;
}

type PreviewScrollListener = (position: PreviewScrollPosition) => void;

/** Clamp an arbitrary number to the proportional-scroll range. */
export function clampScrollRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

/** Normalised vertical progress for DOM and Monaco scroll surfaces. */
export function normalisedScrollRatio(
  scrollTop: number,
  scrollHeight: number,
  viewportHeight: number,
): number {
  return clampScrollRatio(scrollTop / Math.max(1, scrollHeight - viewportHeight));
}

/** Concrete scroll offset for a proportional position after any reflow. */
export function scrollTopForRatio(
  ratio: number,
  scrollHeight: number,
  viewportHeight: number,
): number {
  return clampScrollRatio(ratio) * Math.max(0, scrollHeight - viewportHeight);
}

function storeKey(channel: string, target: PreviewScrollTarget): string {
  // JSON encoding avoids delimiter collisions. `root` is deliberately present:
  // a worktree file and a rooted external file may share the same relative path.
  return JSON.stringify([channel, target.session, target.root ?? null, target.path]);
}

/**
 * Browser-local semantic scroll state (SPEC §8): source line for accurate
 * alignment, ratio for exact endpoints and unmapped fallbacks. One module
 * instance is one browser window; `channel` further isolates the profile-wide
 * tree from every project-local tree. Nothing persists or crosses the daemon
 * protocol.
 */
export class PreviewScrollStore {
  private readonly positions = new Map<string, PreviewScrollPosition>();
  private readonly listeners = new Map<string, Set<PreviewScrollListener>>();
  private revision = 0;

  publish(
    channel: string,
    target: PreviewScrollTarget,
    ratio: number,
    sourceLine: number | null = null,
  ): PreviewScrollPosition {
    const position = {
      ratio: clampScrollRatio(ratio),
      sourceLine:
        sourceLine !== null && Number.isFinite(sourceLine) ? Math.max(1, sourceLine) : null,
      revision: ++this.revision,
    };
    const key = storeKey(channel, target);
    this.positions.set(key, position);
    for (const listener of this.listeners.get(key) ?? []) listener(position);
    return position;
  }

  get(channel: string, target: PreviewScrollTarget): PreviewScrollPosition | undefined {
    return this.positions.get(storeKey(channel, target));
  }

  /** Subscribe to one target and replay only that target's latest value. */
  subscribe(
    channel: string,
    target: PreviewScrollTarget,
    listener: PreviewScrollListener,
  ): () => void {
    const key = storeKey(channel, target);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    const current = this.positions.get(key);
    if (current) listener(current);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) this.listeners.delete(key);
    };
  }
}

export const previewScrollStore = new PreviewScrollStore();
/** Each rendered tab remembers its own position, independent of scroll ownership. */
export const previewViewPositions = new ViewStateStore<PreviewScrollPosition>();

export interface AnimationFramePublisher {
  schedule(): void;
  dispose(): void;
}

/** Coalesce any number of measurements into the last callback of one frame. */
export function createAnimationFramePublisher(publish: () => void): AnimationFramePublisher {
  let frame: number | null = null;
  return {
    schedule: () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        publish();
      });
    },
    dispose: () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}

interface ScrollElement {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  addEventListener(
    type: 'scroll',
    listener: EventListener,
    options?: AddEventListenerOptions,
  ): void;
  removeEventListener(type: 'scroll', listener: EventListener): void;
}

export interface PreviewScrollBinding {
  viewKey?: string;
  channel: string;
  target: PreviewScrollTarget;
  driver: boolean;
  receiver: boolean;
  /** Observe the outer viewport and inner content so delayed reflow reapplies. */
  resizeElements?: Element[];
  /** Current parser-annotated source/rendered map, measured after layout. */
  sourceAnchors?: () => readonly SourceAnchor[];
  store?: PreviewScrollStore;
}

/** Resolve semantic line position first, retaining ratio as the safe fallback. */
export function scrollTopForPosition(
  position: Pick<PreviewScrollPosition, 'ratio' | 'sourceLine'>,
  scrollHeight: number,
  viewportHeight: number,
  sourceAnchors?: readonly SourceAnchor[],
): number {
  const maximum = Math.max(0, scrollHeight - viewportHeight);
  // Exact endpoints matter more than sparse parser maps: both surfaces should
  // reach the beginning/end together even when the final block is very tall.
  if (position.ratio <= 0) return 0;
  if (position.ratio >= 1) return maximum;
  if (position.sourceLine !== null && sourceAnchors) {
    const offset = offsetAtSourceLine(sourceAnchors, position.sourceLine);
    if (offset !== null) return Math.min(maximum, Math.max(0, offset));
  }
  return scrollTopForRatio(position.ratio, scrollHeight, viewportHeight);
}

/**
 * Bind a Markdown-like DOM scroller. Parser anchors are measured on reflow,
 * then reused while scrolling; drivers publish at most once per frame and
 * receivers never listen to their own scroll, so they cannot feed back.
 * Logical focus promotes a receiving source/locked surface to the driver
 * before user scrolling, so the binding itself can remain strictly one-way.
 */
export function bindPreviewScrollElement(
  element: ScrollElement,
  binding: PreviewScrollBinding,
): () => void {
  if (binding.driver && binding.receiver) {
    throw new Error('a preview scroll surface cannot be both driver and receiver');
  }
  const store = binding.store ?? previewScrollStore;
  let current = binding.viewKey ? previewViewPositions.get(binding.viewKey) : undefined;
  let sourceAnchors = binding.sourceAnchors?.();
  let unsubscribe: () => void = () => undefined;
  let frames: AnimationFramePublisher | undefined;

  const apply = (position: PreviewScrollPosition) => {
    current = position;
    if (binding.viewKey) previewViewPositions.set(binding.viewKey, position);
    element.scrollTop = scrollTopForPosition(
      position,
      element.scrollHeight,
      element.clientHeight,
      sourceAnchors,
    );
  };

  if (current) apply(current);
  const remember = () => {
    if (element.clientHeight <= 0) return;
    const ratio = normalisedScrollRatio(
      element.scrollTop,
      element.scrollHeight,
      element.clientHeight,
    );
    const sourceLine = sourceAnchors ? sourceLineAtOffset(sourceAnchors, element.scrollTop) : null;
    current = { ratio, sourceLine, revision: 0 };
    if (binding.viewKey) previewViewPositions.set(binding.viewKey, current);
    if (binding.driver) store.publish(binding.channel, binding.target, ratio, sourceLine);
  };

  if (binding.receiver) {
    // Subscribe before applying: subscribe's replay belongs only to this exact
    // target, so a retarget with no publisher waits instead of reusing old state.
    unsubscribe = store.subscribe(binding.channel, binding.target, apply);
  } else if (binding.driver || binding.viewKey) {
    frames = createAnimationFramePublisher(remember);
    element.addEventListener('scroll', frames.schedule, { passive: true });
    frames.schedule();
  }

  const observer = new ResizeObserver(() => {
    sourceAnchors = binding.sourceAnchors?.();
    if (current) apply(current);
    else frames?.schedule();
  });
  for (const resized of binding.resizeElements ?? []) observer.observe(resized);

  return () => {
    if (frames) {
      // Don't drop a user's last scroll when switching before the next frame.
      remember();
      element.removeEventListener('scroll', frames.schedule);
    }
    unsubscribe();
    observer.disconnect();
    frames?.dispose();
  };
}
