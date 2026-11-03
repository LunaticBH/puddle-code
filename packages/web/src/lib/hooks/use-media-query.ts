import { useEffect, useState } from 'react';

/**
 * Tracks a CSS media query as React state (subscribes to `matchMedia`, so a
 * resize or rotation re-renders). Pass a stable query string.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/**
 * Below Tailwind's `md` step: the phone layout (SPEC §12 narrow viewports).
 * The workspace swaps its three-panel shell for rails + overlay sidebars here.
 */
export const NARROW_VIEWPORT = '(max-width: 767px)';
