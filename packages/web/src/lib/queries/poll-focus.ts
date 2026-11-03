import { focusManager } from '@tanstack/react-query';

/**
 * Focus-aware polling. TanStack's focusManager pauses refetch intervals only
 * when the document is HIDDEN (`visibilityState`), so a window that is visible
 * but not focused — puddle sitting beside the editor, the normal laptop-idle
 * case — polls at full rate forever. That is a real battery cost: every tick
 * is a daemon round-trip (and for ports, an `lsof` on the host).
 *
 * The compromise: while the window is unfocused, intervals stretch by
 * `UNFOCUSED_FACTOR` instead of stopping (the cockpit stays truthful, just
 * slower), and a refocus snaps back immediately — the window `focus` event is
 * fed to the focusManager so stale queries refetch at once and interval
 * functions are re-evaluated.
 */

const UNFOCUSED_FACTOR = 12;

let windowFocused = typeof document !== 'undefined' ? document.hasFocus() : true;

if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    windowFocused = true;
  });
  window.addEventListener('blur', () => {
    windowFocused = false;
  });

  // Have refocus (not just tab-visibility) count as a focus event: stale
  // queries catch up the moment the user comes back. `setFocused(undefined)`
  // keeps `isFocused()` on its visibility-based default — blur must NOT stop
  // interval polling, only stretch it.
  focusManager.setEventListener((setFocused) => {
    const onFocusish = () => setFocused(undefined);
    window.addEventListener('visibilitychange', onFocusish, false);
    window.addEventListener('focus', onFocusish, false);
    return () => {
      window.removeEventListener('visibilitychange', onFocusish);
      window.removeEventListener('focus', onFocusish);
    };
  });
}

/**
 * A `refetchInterval` that runs at `focusedMs` while the window has focus and
 * `UNFOCUSED_FACTOR`× slower while it doesn't. Hidden-tab behaviour is
 * unchanged (`refetchIntervalInBackground` still decides that).
 */
export function focusAwareInterval(focusedMs: number): () => number {
  return () => (windowFocused ? focusedMs : focusedMs * UNFOCUSED_FACTOR);
}
