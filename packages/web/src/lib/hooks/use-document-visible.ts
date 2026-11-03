import { useSyncExternalStore } from 'react';

function subscribe(callback: () => void): () => void {
  document.addEventListener('visibilitychange', callback);
  return () => document.removeEventListener('visibilitychange', callback);
}

/**
 * True while the document is visible. Drives pausing work a hidden tab cannot
 * show anyway (terminal parsing, rendering) — the daemon side of everything
 * paused this way keeps running untouched.
 */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, () => document.visibilityState === 'visible');
}
