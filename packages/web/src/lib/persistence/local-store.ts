/**
 * Tiny localStorage-backed external stores, subscribable via
 * useSyncExternalStore so token/profile changes re-render the shell.
 */
export interface LocalValue {
  get(): string | null;
  set(value: string | null): void;
  subscribe(listener: () => void): () => void;
}

export function localValue(key: string): LocalValue {
  const listeners = new Set<() => void>();
  return {
    get: () => localStorage.getItem(browserScope(key)),
    set(value) {
      if (value === null) localStorage.removeItem(browserScope(key));
      else localStorage.setItem(browserScope(key), value);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
import { browserScope } from '../transport/browser-transport';
