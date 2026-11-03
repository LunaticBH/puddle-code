/**
 * `editor-sync.ts` is backed by `BroadcastChannel`, which — unlike
 * `indexedDB` — this repo's vitest environment (plain Node) DOES provide as
 * a global (verified empirically: `new BroadcastChannel('x')` in one
 * instance is received by a second same-named instance in the same
 * process). So these tests drive the real implementation: our module's
 * singleton channel plus a second, independently-created `BroadcastChannel`
 * representing "another window" in the test.
 *
 * The no-`BroadcastChannel` fallback (older Safari) is exercised separately
 * by stubbing the global away and re-importing the module fresh.
 *
 * Deliberately does NOT import `buffer-store.ts` (not even for its
 * `bufferKey` helper): that module reaches for `window` via `monaco-setup.ts`
 * at import time and throws under this repo's Node vitest environment (see
 * `buffer-store.test.ts`). `editor-sync.ts` mirrors `bufferKey`'s format
 * internally for exactly this reason, so this test recomputes the same
 * `<session>:<path>` (percent-encoded) format inline instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  announceDraftDiscarded,
  announceDraftUpdated,
  announceSaved,
  clearPeerState,
  onEditorSync,
  peerState,
  subscribePeerState,
  type EditorSyncMessage,
} from '../../../src/features/editor/buffers/editor-sync';

/** Mirrors `bufferKey` (buffer-store.ts) / `peerKey` (editor-sync.ts) — see the docblock above. */
function bufferKey(session: string, path: string): string {
  return `${encodeURIComponent(session)}:${encodeURIComponent(path)}`;
}

/** Waits for one message on an external channel standing in for another window. */
function nextMessage(bc: BroadcastChannel): Promise<EditorSyncMessage> {
  return new Promise((resolve) => {
    bc.onmessage = (evt: MessageEvent<EditorSyncMessage>) => resolve(evt.data);
  });
}

/** Waits for one firing of a peer-state subscription (real BroadcastChannel delivery is async). */
function nextPeerNotification(key: string): Promise<void> {
  return new Promise((resolve) => {
    const off = subscribePeerState(key, () => {
      off();
      resolve();
    });
  });
}

describe('editor-sync', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('announceSaved/DraftUpdated/DraftDiscarded broadcast to other windows', async () => {
    const peer = new BroadcastChannel('puddle-editor');
    try {
      const saved = nextMessage(peer);
      announceSaved('s1', 'a.ts', 1000);
      expect(await saved).toEqual({ t: 'saved', session: 's1', path: 'a.ts', mtime_ms: 1000 });

      const updated = nextMessage(peer);
      announceDraftUpdated('s1', 'a.ts');
      expect(await updated).toEqual({ t: 'draft-updated', session: 's1', path: 'a.ts' });

      const discarded = nextMessage(peer);
      announceDraftDiscarded('s1', 'a.ts');
      expect(await discarded).toEqual({ t: 'draft-discarded', session: 's1', path: 'a.ts' });
    } finally {
      peer.close();
    }
  });

  it('onEditorSync receives every raw message', async () => {
    const peer = new BroadcastChannel('puddle-editor');
    const received: EditorSyncMessage[] = [];
    const off = onEditorSync((msg) => received.push(msg));
    try {
      peer.postMessage({ t: 'saved', session: 's-onsync', path: 'b.ts', mtime_ms: 5 });
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toEqual({ t: 'saved', session: 's-onsync', path: 'b.ts', mtime_ms: 5 });
    } finally {
      off();
      peer.close();
    }
  });

  it('draft-updated from another window sets dirtyElsewhere', async () => {
    const key = bufferKey('s2', 'c.ts');
    const peer = new BroadcastChannel('puddle-editor');
    try {
      expect(peerState(key)).toEqual({ dirtyElsewhere: false, savedElsewhere: false });
      const notified = nextPeerNotification(key);
      peer.postMessage({
        t: 'draft-updated',
        session: 's2',
        path: 'c.ts',
      } satisfies EditorSyncMessage);
      await notified;
      expect(peerState(key)).toEqual({ dirtyElsewhere: true, savedElsewhere: false });
    } finally {
      peer.close();
      clearPeerState(key);
    }
  });

  it('saved from another window clears dirtyElsewhere and sets savedElsewhere', async () => {
    const key = bufferKey('s3', 'd.ts');
    const peer = new BroadcastChannel('puddle-editor');
    try {
      peer.postMessage({
        t: 'draft-updated',
        session: 's3',
        path: 'd.ts',
      } satisfies EditorSyncMessage);
      await vi.waitFor(() => expect(peerState(key).dirtyElsewhere).toBe(true));

      peer.postMessage({
        t: 'saved',
        session: 's3',
        path: 'd.ts',
        mtime_ms: 42,
      } satisfies EditorSyncMessage);
      await vi.waitFor(() => expect(peerState(key).savedElsewhere).toBe(true));
      expect(peerState(key)).toEqual({ dirtyElsewhere: false, savedElsewhere: true });
    } finally {
      peer.close();
      clearPeerState(key);
    }
  });

  it('draft-discarded from another window clears dirtyElsewhere without setting savedElsewhere', async () => {
    const key = bufferKey('s4', 'e.ts');
    const peer = new BroadcastChannel('puddle-editor');
    try {
      peer.postMessage({
        t: 'draft-updated',
        session: 's4',
        path: 'e.ts',
      } satisfies EditorSyncMessage);
      await vi.waitFor(() => expect(peerState(key).dirtyElsewhere).toBe(true));

      peer.postMessage({
        t: 'draft-discarded',
        session: 's4',
        path: 'e.ts',
      } satisfies EditorSyncMessage);
      await vi.waitFor(() => expect(peerState(key).dirtyElsewhere).toBe(false));
      expect(peerState(key)).toEqual({ dirtyElsewhere: false, savedElsewhere: false });
    } finally {
      peer.close();
      clearPeerState(key);
    }
  });

  it('clearPeerState resets to the default and notifies subscribers', async () => {
    const key = bufferKey('s5', 'f.ts');
    const peer = new BroadcastChannel('puddle-editor');
    try {
      peer.postMessage({
        t: 'saved',
        session: 's5',
        path: 'f.ts',
        mtime_ms: 1,
      } satisfies EditorSyncMessage);
      await vi.waitFor(() => expect(peerState(key).savedElsewhere).toBe(true));

      const notified = nextPeerNotification(key);
      clearPeerState(key);
      await notified;
      expect(peerState(key)).toEqual({ dirtyElsewhere: false, savedElsewhere: false });
    } finally {
      peer.close();
    }
  });

  it('unsubscribe stops further notifications for that listener', async () => {
    const key = bufferKey('s6', 'g.ts');
    const peer = new BroadcastChannel('puddle-editor');
    let calls = 0;
    const off = subscribePeerState(key, () => {
      calls++;
    });
    try {
      peer.postMessage({
        t: 'draft-updated',
        session: 's6',
        path: 'g.ts',
      } satisfies EditorSyncMessage);
      await vi.waitFor(() => expect(calls).toBe(1));

      off();
      peer.postMessage({
        t: 'saved',
        session: 's6',
        path: 'g.ts',
        mtime_ms: 9,
      } satisfies EditorSyncMessage);
      // Give the (now unsubscribed) listener a chance to have fired if it wrongly still would.
      await vi.waitFor(() => expect(peerState(key).savedElsewhere).toBe(true));
      expect(calls).toBe(1);
    } finally {
      peer.close();
      clearPeerState(key);
    }
  });

  it('falls back to an inert no-op when BroadcastChannel is unavailable', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.resetModules();
    const fresh = await import('../../../src/features/editor/buffers/editor-sync');
    expect(() => fresh.announceSaved('s', 'p', 1)).not.toThrow();
    expect(fresh.peerState(bufferKey('s', 'p'))).toEqual({
      dirtyElsewhere: false,
      savedElsewhere: false,
    });
    const off = fresh.onEditorSync(() => {
      throw new Error('the no-op channel must never deliver a message');
    });
    off();
  });
});
