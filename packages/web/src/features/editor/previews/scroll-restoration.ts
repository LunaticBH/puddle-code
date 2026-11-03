import { ViewStateStore } from '../tabs/view-state-store';

export interface ScrollPosition {
  top: number;
  left: number;
  height: number;
  width: number;
}

export const scrollPositions = new ViewStateStore<ScrollPosition>();

export interface ScrollRestoration {
  capture(): void;
  dispose(): void;
}

/**
 * Restore after both mounting and delayed content layout. A short loading
 * surface must never overwrite the location of the document it is replacing.
 */
export function bindScrollRestoration(
  element: HTMLElement,
  content: HTMLElement,
  key: string,
  ready: () => boolean = () => true,
): ScrollRestoration {
  let position = scrollPositions.get(key);
  let height = -1;
  let width = -1;
  const dimensions = () => ({
    height: Math.max(0, element.scrollHeight - element.clientHeight),
    width: Math.max(0, element.scrollWidth - element.clientWidth),
  });
  const restore = () => {
    if (!ready() || !element.clientHeight || !element.clientWidth) return;
    ({ height, width } = dimensions());
    if (!position) return;
    element.scrollTop = position.height ? (position.top / position.height) * height : 0;
    element.scrollLeft = position.width ? (position.left / position.width) * width : 0;
  };
  const capture = () => {
    if (!ready() || !element.clientHeight || !element.clientWidth) return;
    const size = dimensions();
    ({ height, width } = size);
    position = { top: element.scrollTop, left: element.scrollLeft, ...size };
    scrollPositions.set(key, position);
  };
  const remember = () => {
    if (!ready() || !element.clientHeight || !element.clientWidth) return;
    const size = dimensions();
    // Layout/clamping can emit scroll before ResizeObserver. Restore first;
    // only stable geometry is evidence of a new user scroll position.
    if (size.height !== height || size.width !== width) {
      restore();
      return;
    }
    capture();
  };
  restore();
  element.addEventListener('scroll', remember, { passive: true });
  const observer = new ResizeObserver(restore);
  observer.observe(element);
  observer.observe(content);
  const mutations = new MutationObserver(restore);
  mutations.observe(content, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-scroll-ready'],
  });
  return {
    capture,
    dispose: () => {
      remember();
      element.removeEventListener('scroll', remember);
      observer.disconnect();
      mutations.disconnect();
    },
  };
}
