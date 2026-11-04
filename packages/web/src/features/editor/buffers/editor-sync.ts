/**
 * Cross-window editor coordination (SPEC §11 "Reload semantics") — the
 * user-confirmed model is conflict-safe independent editing, NOT live
 * keystroke mirroring: two windows may have the same (session, path) open
 * at once, each with its own buffer, and this module only carries coarse
 * "something happened elsewhere" signals so a window can warn its user
 * before silently clobbering a peer's work:
 *   - `saved`          — another window wrote (session, path) to disk.
 *   - `draft-updated`  — another window now has unsaved edits for it.
 *   - `draft-discarded`— another window discarded its draft for it.
 *
 * Backed by `BroadcastChannel('puddle-editor')`. Guarded for environments
 * without it (older Safari): construction falls back to an inert no-op
 * implementation that never sends and never delivers. (This repo's vitest
 * environment — plain Node — DOES provide a global `BroadcastChannel`,
 * verified empirically, so the real implementation is exercised in tests,
 * not just the fallback.)
 *
 * Behind the editor's lazy boundary (Task 4) — it lives in `features/editor/`
 * alongside `buffer-store.ts` — but it deliberately does NOT import from
 * `buffer-store.ts`: that module imports `monaco-setup.ts`, which reaches
 * for `window` at load time and throws under this repo's vitest environment
 * (plain Node — see `buffer-store.test.ts`'s docblock for the same finding).
 * Importing it here would make this module untestable too. Instead,
 * `peerKey` below duplicates `buffer-store.ts`'s tiny `bufferKey` formula
 * (percent-encode session and path, join with `:`) — callers are expected
 * to pass the SAME `bufferKey(session, path)` string as the `key` for both
 * `subscribe`/dirty-state (buffer-store.ts) and `peerState`/`subscribePeerState`
 * (here), so the two must keep computing identical strings for identical
 * inputs. If `buffer-store.ts`'s `bufferKey` ever changes its format, update
 * `peerKey` to match.
 */

/** Mirrors `bufferKey` in `buffer-store.ts` — see the module doc comment above. */
function peerKey(session: string, path: string, root?: string): string {
  const base = `${encodeURIComponent(session)}:${encodeURIComponent(path)}`;
  return root === undefined ? base : `${base}:${encodeURIComponent(root)}`;
}

export type EditorSyncMessage =
  | { t: 'saved'; session: string; path: string; mtime_ms: number; root?: string }
  | { t: 'draft-updated'; session: string; path: string; root?: string }
  | { t: 'draft-discarded'; session: string; path: string; root?: string };

export interface PeerState {
  /** Another window has unsaved edits for this (session, path). */
  dirtyElsewhere: boolean;
  /** Another window saved this (session, path) since we last cleared it. */
  savedElsewhere: boolean;
}

const CHANNEL_NAME = 'puddle-editor';
const NO_PEER_STATE: PeerState = { dirtyElsewhere: false, savedElsewhere: false };

interface SyncChannel {
  post(msg: EditorSyncMessage): void;
  onMessage(listener: (msg: EditorSyncMessage) => void): () => void;
}

function createChannel(): SyncChannel {
  if (typeof BroadcastChannel === 'undefined') {
    return { post: () => undefined, onMessage: () => () => undefined };
  }
  const bc = new BroadcastChannel(CHANNEL_NAME);
  const listeners = new Set<(msg: EditorSyncMessage) => void>();
  bc.onmessage = (evt: MessageEvent<EditorSyncMessage>) => {
    for (const listener of listeners) listener(evt.data);
  };
  return {
    post: (msg) => bc.postMessage(msg),
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const channel = createChannel();

const peerStates = new Map<string, PeerState>();
const peerListeners = new Map<string, Set<() => void>>();

function notifyPeer(key: string): void {
  for (const listener of peerListeners.get(key) ?? []) listener();
}

function setPeerState(key: string, patch: Partial<PeerState>): void {
  const current = peerStates.get(key) ?? NO_PEER_STATE;
  peerStates.set(key, { ...current, ...patch });
  notifyPeer(key);
}

channel.onMessage((msg) => {
  const key = peerKey(msg.session, msg.path, msg.root);
  switch (msg.t) {
    case 'draft-updated':
      setPeerState(key, { dirtyElsewhere: true });
      break;
    case 'saved':
      setPeerState(key, { dirtyElsewhere: false, savedElsewhere: true });
      break;
    case 'draft-discarded':
      setPeerState(key, { dirtyElsewhere: false });
      break;
  }
});

export function announceSaved(session: string, path: string, mtimeMs: number, root?: string): void {
  channel.post({
    t: 'saved',
    session,
    path,
    mtime_ms: mtimeMs,
    ...(root === undefined ? {} : { root }),
  });
}

export function announceDraftUpdated(session: string, path: string, root?: string): void {
  channel.post({ t: 'draft-updated', session, path, ...(root === undefined ? {} : { root }) });
}

export function announceDraftDiscarded(session: string, path: string, root?: string): void {
  channel.post({ t: 'draft-discarded', session, path, ...(root === undefined ? {} : { root }) });
}

/** Subscribe to every raw sync message (any session/path), e.g. for logging. */
export function onEditorSync(listener: (msg: EditorSyncMessage) => void): () => void {
  return channel.onMessage(listener);
}

/** Current peer-state for `key` (`bufferKey(session, path)`); never null. */
export function peerState(key: string): PeerState {
  return peerStates.get(key) ?? NO_PEER_STATE;
}

/** `useSyncExternalStore`-compatible subscription to one key's peer-state. */
export function subscribePeerState(key: string, listener: () => void): () => void {
  let set = peerListeners.get(key);
  if (!set) {
    set = new Set();
    peerListeners.set(key, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}

/** Clears local peer-state for `key` — call once the local buffer reloads. */
export function clearPeerState(key: string): void {
  if (!peerStates.delete(key)) return;
  notifyPeer(key);
}
