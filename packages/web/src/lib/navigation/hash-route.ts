import { useSyncExternalStore } from 'react';

/**
 * Settings-dialog open state, with `#settings/<section>` deep links — a single
 * external store read via `useSyncExternalStore`, the same pattern as
 * `tokenStore` and `clientSettings`. The module-level `current` is the ONLY
 * copy of the state: every consumer renders from that one snapshot, so the
 * dialog and any gate can never disagree with it. (The previous hand-rolled
 * fan-out gave each consumer its own `useState` copy; any copy that lagged the
 * module state left `current` claiming "open" while nothing rendered — and the
 * next click's open was deduped against `current` into a no-op. That was the
 * "settings button sometimes does nothing" bug, twice survived by earlier
 * fixes.)
 *
 * The URL is only a MIRROR, written via `replaceState` in a microtask after
 * subscribers are notified — off the open's critical path (writing
 * `location.hash` inside the click handler once swallowed the opening
 * re-render), and `replaceState` fires no `hashchange`, so no loop.
 */

const listeners = new Set<() => void>();

function parseSection(hash: string): string | null {
  const match = /^#settings\/([\w-]+)$/.exec(hash);
  return match ? match[1]! : null;
}

// Deep-link on first load: a URL that already carries #settings/<section>
// opens straight to it.
let current: string | null = parseSection(window.location.hash);

function mirrorToUrl(): void {
  const want = current ? `#settings/${current}` : '';
  if (window.location.hash === want) return;
  history.replaceState(null, '', window.location.pathname + window.location.search + want);
}

function emit(next: string | null): void {
  if (next !== current) {
    current = next;
    for (const listener of listeners) listener();
  }
  // Re-assert the mirror even on a no-op (a router navigation may have
  // stripped the hash without firing any event).
  queueMicrotask(mirrorToUrl);
}

// Back/forward and any external hash edit drive the state from the URL. Our
// own mirror uses replaceState, which fires neither event, so there's no loop.
window.addEventListener('hashchange', () => emit(parseSection(window.location.hash)));
window.addEventListener('popstate', () => emit(parseSection(window.location.hash)));

/** The open settings section, or null when the dialog is closed. */
export function useSettingsSection(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => current,
  );
}

export function openSettings(next = 'appearance'): void {
  emit(next);
}

export function closeSettings(): void {
  emit(null);
}
