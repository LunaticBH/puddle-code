/**
 * `useUiState` (use-ui-state.ts) is a React hook, and this repo has neither
 * jsdom nor a React test renderer as a dependency (verified: `test: { name:
 * 'web' }` runs under plain Node, and adding `@testing-library/react` or
 * `react-test-renderer` would be a new dependency, against this task's
 * constraint) — so the hook's `useEffect`/`useState` plumbing itself cannot
 * be exercised here, the same limitation `buffer-store.test.ts` documents
 * for monaco. What CAN be — and is, below — is every decision the hook
 * delegates to pure, DOM-free functions: `workingSetKey` (the sessionStorage
 * key format) and `parseWorkingSet` (sessionStorage-beats-server-fetch,
 * fresh-window-falls-back-to-server, and corrupt-JSON/corrupt-schema both
 * fall back and are the caller's cue to clear the key — see the hook's own
 * doc comment for how it wires these together). The debounced-PUT behaviour
 * itself is unchanged and already covered by the `debounce` suite below;
 * `update` now schedules the durable `writer()` PUT *before* touching
 * `sessionStorage` and wraps every storage read/write in try/catch (so a
 * quota/SecurityError can neither skip the server write nor wedge the loading
 * gate) — both are single, DOM-bound lines reviewed by inspection, since the
 * hook can't be mounted here. Full hook-level integration (mount, reload,
 * multi-window, a throwing storage backend) remains a manual check — see the
 * task report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStateSnapshotSchema } from '@puddle/shared';
import { debounce } from '../../src/lib/debounce';
import { parseWorkingSet, workingSetKey } from '../../src/features/workspace/use-ui-state';

describe('uiStateSnapshotSchema', () => {
  it('fills defaults for an empty snapshot', () => {
    expect(uiStateSnapshotSchema.parse({})).toEqual({
      session_tabs: [],
      active_session: null,
      editor_tabs: [],
      layout: {},
      explorer_pin: null,
      active_editor_tab: null,
      explorer_open: true,
      sidebar_mode: 'files',
      sidebar_collapsed: false,
      sessions_collapsed: false,
      // right_panel is retired: optional without a default, never injected.
      session_order: [],
      layout_tree: null,
      // layout_mode is optional without a default: absent means profile.
      project_layouts: {},
      layout_ref: null,
    });
  });

  it('round-trips a full snapshot through JSON', () => {
    const id = '3b241101-e2bb-4255-8caf-4136c566a962';
    const snapshot = uiStateSnapshotSchema.parse({
      session_tabs: [id],
      active_session: id,
      editor_tabs: [{ session: id, path: 'src/index.ts' }],
      layout: { sidebar: 260, main: 980 },
      explorer_pin: null,
    });
    expect(uiStateSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it('preserves unknown keys so later phases extend without migrations', () => {
    const parsed = uiStateSnapshotSchema.parse({ future_pane: { open: true } });
    expect((parsed as Record<string, unknown>)['future_pane']).toEqual({ open: true });
  });

  it('rejects non-uuid session tabs', () => {
    expect(uiStateSnapshotSchema.safeParse({ session_tabs: ['not-a-uuid'] }).success).toBe(false);
  });
});

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once with the last arguments after the delay', () => {
    const fn = vi.fn();
    const d = debounce(fn, 2000);
    d('first');
    vi.advanceTimersByTime(1000);
    d('second');
    vi.advanceTimersByTime(1999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledExactlyOnceWith('second');
  });

  it('flush runs a pending call immediately, and only once', () => {
    const fn = vi.fn();
    const d = debounce(fn, 2000);
    d('state');
    d.flush();
    expect(fn).toHaveBeenCalledExactlyOnceWith('state');
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush and cancel are no-ops with nothing pending', () => {
    const fn = vi.fn();
    const d = debounce(fn, 2000);
    d.flush();
    d.cancel();
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending()).toBe(false);
  });

  it('cancel drops the pending call', () => {
    const fn = vi.fn();
    const d = debounce(fn, 2000);
    d('state');
    d.cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('workingSetKey', () => {
  it('namespaces by profile alone — the workspace is shared across projects', () => {
    expect(workingSetKey('profile-1')).toBe('puddle.ws.profile-1');
  });

  it('differs for different profiles', () => {
    expect(workingSetKey('profile-1')).not.toBe(workingSetKey('profile-2'));
  });
});

describe('parseWorkingSet', () => {
  it('is "absent" for a fresh window (no sessionStorage entry) — falls back to the server fetch', () => {
    expect(parseWorkingSet(null)).toEqual({ kind: 'absent' });
  });

  it('is "present" and restores a valid stored snapshot — beats the server fetch', () => {
    const id = '3b241101-e2bb-4255-8caf-4136c566a962';
    const snapshot = uiStateSnapshotSchema.parse({ session_tabs: [id], active_session: id });
    const result = parseWorkingSet(JSON.stringify(snapshot));
    expect(result).toEqual({ kind: 'present', snapshot });
  });

  it('fills schema defaults for a present-but-partial stored snapshot', () => {
    const result = parseWorkingSet(JSON.stringify({ explorer_open: false }));
    expect(result).toEqual({
      kind: 'present',
      snapshot: uiStateSnapshotSchema.parse({ explorer_open: false }),
    });
  });

  it('is "corrupt" for invalid JSON — the caller clears the key and falls back to the server', () => {
    expect(parseWorkingSet('{not json')).toEqual({ kind: 'corrupt' });
  });

  it('is "corrupt" for JSON that fails schema validation', () => {
    expect(parseWorkingSet(JSON.stringify({ session_tabs: ['not-a-uuid'] }))).toEqual({
      kind: 'corrupt',
    });
  });
});
