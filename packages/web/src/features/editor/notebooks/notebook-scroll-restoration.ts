import { ViewStateStore } from '../tabs/view-state-store';

interface NotebookPosition {
  cell: string | undefined;
  offset: number;
  top: number;
  left: number;
}

const positions = new ViewStateStore<NotebookPosition>();

/** Restore the reading cell on reopen, then let native scroll anchoring own live layout. */
export function bindNotebookScrollRestoration(
  element: HTMLElement,
  content: HTMLElement,
  key: string,
) {
  const saved = positions.get(key);
  let restoring = !!saved;
  let restoredTop = element.scrollTop;
  const usable = () => element.clientHeight > 0 && element.clientWidth > 0;
  const capture = () => {
    if (!usable()) return;
    const top = element.getBoundingClientRect().top;
    const cell = [...content.querySelectorAll<HTMLElement>('[data-cell-id]')].find(
      (cell) => cell.getBoundingClientRect().bottom > top,
    );
    positions.set(key, {
      cell: cell?.dataset.cellId,
      offset: cell ? cell.getBoundingClientRect().top - top : 0,
      top: element.scrollTop,
      left: element.scrollLeft,
    });
  };
  const restore = () => {
    if (!restoring || !saved || !usable()) return;
    const cell = saved.cell
      ? content.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(saved.cell)}"]`)
      : null;
    element.scrollTop = cell
      ? element.scrollTop +
        cell.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        saved.offset
      : saved.top;
    element.scrollLeft = saved.left;
    restoredTop = element.scrollTop;
  };
  const interact = () => {
    restoring = false;
  };
  const scroll = () => {
    // Explicit reveals and scrollbar/keyboard gestures also supersede reopening.
    if (element.scrollTop !== restoredTop) restoring = false;
    if (!restoring) capture();
  };
  restore();
  const observer = new ResizeObserver(restore);
  observer.observe(element);
  observer.observe(content);
  element.addEventListener('scroll', scroll, { passive: true });
  const gestures = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
  for (const event of gestures) element.addEventListener(event, interact, { passive: true });
  return () => {
    if (!restoring) capture();
    observer.disconnect();
    element.removeEventListener('scroll', scroll);
    for (const event of gestures) element.removeEventListener(event, interact);
  };
}
