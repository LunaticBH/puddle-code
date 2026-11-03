import { describe, expect, it } from 'vitest';
import { UNTITLED_SESSION, uiStateSnapshotSchema, type Session } from '@puddle/shared';
import {
  explorerLocationPath,
  projectDirectorySession,
  useExplorerTarget,
  withBrowseReset,
  type ProjectDirectory,
} from '../../src/features/explorer/use-explorer-target';
import type { UiStateHandle } from '../../src/features/workspace/use-ui-state';

/**
 * `useExplorerTarget` calls no hooks — it derives from the snapshot it is handed
 * — so it is exercised here directly, without a renderer.
 */
const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  project_id: 'aaaaaaaaaa',
  account_id: null,
  worktree_path: `/wt/${id}`,
  base_branch: 'main',
  branch: `puddle/${id}`,
  separate_branch: true,
  kind: 'agent',
  agent_type: 'claude-code',
  agent_session_ref: null,
  title: null,
  status: 'running',
  skip_permissions: false,
  created_at: '2026-08-03T00:00:00.000Z',
  updated_at: '2026-08-03T00:00:00.000Z',
  last_activity_at: null,
  ...over,
});

const handle = (pin: string | null = null): UiStateHandle => {
  let snapshot = uiStateSnapshotSchema.parse({ explorer_pin: pin });
  return {
    loaded: true,
    get snapshot() {
      return snapshot;
    },
    current: () => snapshot,
    update: (patch) => {
      snapshot = { ...snapshot, ...patch };
    },
  };
};

const DIR: ProjectDirectory = {
  path: '/repos/thing',
  projectId: 'aaaaaaaaaa',
  name: 'thing',
  defaultBranch: 'main',
};

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

describe('useExplorerTarget', () => {
  it('binds the bound session, with no root and no directory flag', () => {
    const t = useExplorerTarget([session(S1)], S1, handle(), DIR);
    expect(t.session?.id).toBe(S1);
    expect(t.root).toBeUndefined();
    expect(t.isProjectDirectory).toBe(false);
  });

  it('prefers a live pin over the bound session', () => {
    const t = useExplorerTarget([session(S1), session(S2)], S1, handle(S2), DIR);
    expect(t.session?.id).toBe(S2);
    expect(t.pinned).toBe(true);
  });

  it('falls back to the project directory when nothing qualifies', () => {
    const t = useExplorerTarget([], null, handle(), DIR);
    expect(t.isProjectDirectory).toBe(true);
    expect(t.root).toBe(DIR.path);
    // The stand-in carries the nil uuid, which the daemon reads as "no session"
    // (a directory target), and the directory as its worktree path.
    expect(t.session?.id).toBe(UNTITLED_SESSION);
    expect(t.session?.worktree_path).toBe(DIR.path);
    expect(t.pinned).toBe(false);
  });

  it('falls back when the bound session has gone away entirely', () => {
    expect(useExplorerTarget([], S1, handle(), DIR).isProjectDirectory).toBe(true);
  });

  it('drops an ARCHIVED pin to the directory, but keeps an archived session bound', () => {
    const archived = session(S1, { status: 'archived' });
    // A pin never resolves to an archived session (it would look stuck).
    expect(useExplorerTarget([archived], null, handle(S1), DIR).isProjectDirectory).toBe(true);
    // Bound by the URL or a tab, though, it still has a worktree on disk —
    // archiving keeps it (SPEC §4) — so browsing it is right, not empty.
    expect(useExplorerTarget([archived], S1, handle(), DIR).session?.id).toBe(S1);
  });

  it('keeps the old empty state when no directory is offered (an older daemon)', () => {
    const t = useExplorerTarget([], null, handle(), null);
    expect(t.session).toBeNull();
    expect(t.root).toBeUndefined();
    expect(t.isProjectDirectory).toBe(false);
  });

  it('releases the directory browse and its pin through the shared return path', () => {
    const uiState = handle(S1);
    const target = useExplorerTarget([session(S1)], S1, uiState, DIR);
    let browseOpen = true;

    withBrowseReset(target, () => {
      browseOpen = false;
    }).unpin();

    expect(browseOpen).toBe(false);
    expect(uiState.snapshot.explorer_pin).toBeNull();
  });
});

describe('explorerLocationPath', () => {
  it('uses the worktree, then a directory target, then the active external browse', () => {
    const worktree = useExplorerTarget([session(S1)], S1, handle(), DIR);
    expect(explorerLocationPath(worktree)).toBe(`/wt/${S1}`);

    const directory = useExplorerTarget([], null, handle(), DIR);
    expect(explorerLocationPath(directory)).toBe(DIR.path);

    expect(explorerLocationPath(worktree, '/outside/repository')).toBe('/outside/repository');
  });
});

describe('projectDirectorySession', () => {
  it('is schema-valid, so it flows through props typed for a real session', () => {
    const stand = projectDirectorySession(DIR);
    expect(stand.base_branch).toBe('main');
    expect(stand.title).toBe('thing');
    // never presented as live: nothing should offer to resume or attach to it
    expect(stand.status).toBe('exited');
    expect(stand.account_id).toBeNull();
  });
});
