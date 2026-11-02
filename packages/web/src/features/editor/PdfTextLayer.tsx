import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { PDFPageProxy, TextLayer } from 'pdfjs-dist';
import './pdf-text-layer.css';

/** Native browser selection over the canvas, using the PDF's own text geometry. */
export function PdfTextLayer({ page, scale }: { page: PDFPageProxy; scale: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<TextLayer | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  useLayoutEffect(() => {
    layerRef.current?.update({ viewport: page.getViewport({ scale }) });
  }, [page, scale]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let layer: TextLayer | null = null;

    // PdfViewer has already loaded the library and worker. Keep the same lazy
    // chunk, and retain the text nodes across zooms so selections survive.
    void import('pdfjs-dist')
      .then(async ({ TextLayer }) => {
        if (cancelled) return;
        layer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container,
          viewport: page.getViewport({ scale: scaleRef.current }),
        });
        await layer.render();
        if (cancelled) return;
        layer.update({ viewport: page.getViewport({ scale: scaleRef.current }) });
        layerRef.current = layer;
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // A malformed text stream must not hide an otherwise readable canvas.
        container.replaceChildren();
        console.warn('Couldn’t render PDF text', cause);
      });

    return () => {
      cancelled = true;
      layer?.cancel();
      layerRef.current = null;
      container.replaceChildren();
    };
  }, [page]);

  return (
    <div
      ref={containerRef}
      className="pdf-text-layer"
      style={{ '--total-scale-factor': scale * page.userUnit } as CSSProperties}
    />
  );
}
