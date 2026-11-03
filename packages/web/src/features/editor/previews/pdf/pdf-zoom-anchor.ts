export interface PdfZoomAnchor {
  page: HTMLElement;
  x: number;
  y: number;
  clientX: number;
  clientY: number;
}

/** Keep a point on one page fixed, independent of page gaps and mixed page sizes. */
export function capturePdfZoomAnchor(
  scroller: HTMLElement,
  pointer?: { clientX: number; clientY: number },
): PdfZoomAnchor | null {
  const bounds = scroller.getBoundingClientRect();
  const clientX = pointer?.clientX ?? bounds.left + scroller.clientWidth / 2;
  const clientY = pointer?.clientY ?? bounds.top + scroller.clientHeight / 2;
  let page: HTMLElement | null = null;
  let distance = Infinity;
  for (const candidate of scroller.querySelectorAll<HTMLElement>('[data-pdf-page]')) {
    const rect = candidate.getBoundingClientRect();
    const gap = Math.max(rect.top - clientY, clientY - rect.bottom, 0);
    if (gap < distance) {
      page = candidate;
      distance = gap;
    }
  }
  if (!page) return null;
  const rect = page.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    page,
    clientX,
    clientY,
    x: (clientX - rect.left) / rect.width,
    y: (clientY - rect.top) / rect.height,
  };
}

/** Call after React commits the new page sizes, before painting or saving scroll. */
export function restorePdfZoomAnchor(scroller: HTMLElement, anchor: PdfZoomAnchor): void {
  if (!scroller.contains(anchor.page)) return;
  const rect = anchor.page.getBoundingClientRect();
  scroller.scrollLeft += rect.left + anchor.x * rect.width - anchor.clientX;
  scroller.scrollTop += rect.top + anchor.y * rect.height - anchor.clientY;
}
