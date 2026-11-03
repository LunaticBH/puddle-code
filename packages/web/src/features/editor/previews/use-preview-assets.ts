import { useEffect, type RefObject } from 'react';
import { fetchPreviewAsset } from './preview-assets';
import { parsePreviewSrcset, resolvePreviewAsset, serialisePreviewSrcset } from './preview-kind';

export function usePreviewAssets(
  body: RefObject<HTMLElement | null>,
  html: string,
  session: string,
  path: string,
  root?: string,
) {
  // Resolve worktree images (relative or /-absolute) through the authed media
  // endpoint: image elements carry no bearer header, so the bytes travel as a
  // fetch → object URL (the MediaViewer pattern). Both `src` and `srcset` are
  // covered: a README's theme-aware <picture><source srcset=…> must not bypass
  // the rewrite and ask the browser for a raw cockpit-relative URL.
  useEffect(() => {
    const container = body.current;
    if (!container) return;
    let cancelled = false;
    const urls: string[] = [];

    const objectUrlFor = async (resolved: string): Promise<string | null> => {
      try {
        const blob = await fetchPreviewAsset(session, resolved, root);
        if (cancelled) return null;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        return url;
      } catch {
        return null; // a missing asset just stays blank, like a browser
      }
    };

    for (const element of container.querySelectorAll('img[src], source[src]')) {
      const resolved = resolvePreviewAsset(path, element.getAttribute('src') ?? '');
      if (!resolved) continue;
      element.removeAttribute('src'); // never let the browser chase the raw relative URL
      void objectUrlFor(resolved).then((url) => {
        if (!cancelled && url) element.setAttribute('src', url);
      });
    }

    for (const element of container.querySelectorAll('img[srcset], source[srcset]')) {
      const candidates = parsePreviewSrcset(element.getAttribute('srcset') ?? '');
      const paths = candidates.map(({ ref }) => resolvePreviewAsset(path, ref));
      if (!paths.some((resolved) => resolved !== null)) continue;
      element.removeAttribute('srcset'); // stop eager raw-URL requests while assets load
      void Promise.all(
        candidates.map(async (candidate, index) => {
          const resolved = paths[index];
          if (!resolved) return candidate; // browser-owned external/data URL
          const ref = await objectUrlFor(resolved);
          return ref ? { ...candidate, ref } : null;
        }),
      ).then((rewritten) => {
        if (cancelled) return;
        const available = rewritten.filter((candidate) => candidate !== null);
        if (available.length > 0) {
          element.setAttribute('srcset', serialisePreviewSrcset(available));
        }
      });
    }
    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [html, body, session, path, root]);
}
