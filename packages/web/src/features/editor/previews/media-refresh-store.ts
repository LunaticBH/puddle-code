import { useCallback, useSyncExternalStore } from 'react';

type Listener = () => void;

const revisions = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();

/** Invalidates an open media file after an out-of-band writer replaces it. */
export function bumpMediaRefresh(session: string, path: string, root?: string): void {
  const key = mediaKey(session, path, root);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  for (const listener of listeners.get(key) ?? []) listener();
}

/** A stable revision for one exact (session, root, path) media identity. */
export function useMediaRefresh(session: string, path: string, root?: string): number {
  const key = mediaKey(session, path, root);
  const subscribe = useCallback((listener: Listener) => subscribeKey(key, listener), [key]);
  const snapshot = useCallback(() => revisions.get(key) ?? 0, [key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function subscribeKey(key: string, listener: Listener): () => void {
  let keyListeners = listeners.get(key);
  if (!keyListeners) {
    keyListeners = new Set();
    listeners.set(key, keyListeners);
  }
  keyListeners.add(listener);
  return () => {
    keyListeners.delete(listener);
    if (keyListeners.size === 0) listeners.delete(key);
  };
}

function mediaKey(session: string, path: string, root?: string): string {
  return JSON.stringify([session, root ?? null, path]);
}
