import { mkdtempSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeConversation } from '../../src/agents/adapter.js';
import { ConversationCatalogue } from '../../src/sessions/conversation-catalogue.js';
import { fakeAdapter, fixture, waitFor } from '../helpers/daemon-fixtures.js';

const catalogues: ConversationCatalogue[] = [];
afterEach(() => {
  for (const catalogue of catalogues.splice(0)) catalogue.dispose();
  vi.useRealTimers();
});

function setup(
  opts: {
    missingWatchRoot?: boolean;
    fakeClock?: boolean;
    timings?: ConstructorParameters<typeof ConversationCatalogue>[1];
    fakeWatch?: 'healthy' | 'failed';
    archiveProjectBeforeCatalogue?: boolean;
  } = {},
) {
  const parent = mkdtempSync(join(tmpdir(), 'puddle-native-watch-'));
  const root = opts.missingWatchRoot ? join(parent, 'not-created') : parent;
  let native: NativeConversation[] = [];
  let fail = false;
  let release: (() => void) | null = null;
  let watchListener: (() => void) | null = null;
  const discover = vi.fn(async () => {
    if (release) await new Promise<void>((resolve) => (release = resolve));
    if (fail) throw new Error('store unavailable');
    return native;
  });
  const watchRoots = vi.fn(() => [root]);
  const adapter = {
    ...fakeAdapter(),
    conversationDiscovery: { watchRoots, discover },
  };
  const f = fixture({ adapter });
  if (opts.archiveProjectBeforeCatalogue) {
    f.stores.projects.setArchived(f.ids.project, true);
  }
  if (opts.fakeClock) vi.useFakeTimers();
  const catalogue = new ConversationCatalogue(
    {
      accounts: f.stores.accounts,
      conversations: f.stores.conversations,
      projects: f.stores.projects,
      repos: f.stores.repos,
      sessions: f.stores.sessions,
      adapters: f.adapters,
      worktrees: f.worktrees,
    },
    {
      ...(opts.timings ?? {
        healthySweepMs: 60_000,
        watchDebounceMs: 10,
        deletionVerifyMs: 10,
      }),
      ...(opts.fakeWatch === 'healthy'
        ? {
            watchFactory: (_root: string, listener: () => void) => {
              watchListener = listener;
              return { on: () => undefined, close: () => undefined } as unknown as FSWatcher;
            },
          }
        : opts.fakeWatch === 'failed'
          ? {
              watchFactory: () => {
                throw new Error('watch unavailable');
              },
            }
          : {}),
    },
  );
  catalogues.push(catalogue);
  return {
    f,
    catalogue,
    discover,
    watchRoots,
    setNative: (value: NativeConversation[]) => (native = value),
    setFail: (value: boolean) => (fail = value),
    blockNext: () => {
      release = () => undefined;
      return () => {
        const resolve = release;
        release = null;
        resolve?.();
      };
    },
    triggerWatch: () => watchListener?.(),
  };
}

describe('ConversationCatalogue', () => {
  it('materialises eligible project placements without crossing profile or archive boundaries', async () => {
    const { f, catalogue, setNative } = setup();
    const second = f.stores.projects.create({
      profile_id: f.ids.profile,
      repo_id: f.ids.repo,
      name: 'second',
    });
    const archived = f.stores.projects.create({
      profile_id: f.ids.profile,
      repo_id: f.ids.repo,
      name: 'archived',
    });
    f.stores.projects.setArchived(archived.id, true);
    const foreignProfile = f.stores.profiles.create({ name: 'foreign', branch_prefix: 'foreign/' });
    const foreign = f.stores.projects.create({
      profile_id: foreignProfile.id,
      repo_id: f.ids.repo,
      name: 'foreign',
    });
    setNative([
      {
        ref: 'native-one',
        cwd: f.repoPath,
        title: 'Native title',
        parentRef: null,
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-21T00:00:00.000Z',
      },
    ]);

    catalogue.refreshProject(f.ids.project);
    await waitFor(
      () =>
        f.service.list().filter((session) => session.agent_session_ref === 'native-one').length ===
        2,
    );
    const placements = f.service
      .list()
      .filter((session) => session.agent_session_ref === 'native-one');
    expect(new Set(placements.map((session) => session.project_id))).toEqual(
      new Set([f.ids.project, second.id]),
    );
    expect(placements.every((session) => session.status === 'exited')).toBe(true);
    expect(placements.every((session) => session.branch_owner === false)).toBe(true);
    expect(placements.some((session) => session.project_id === archived.id)).toBe(false);
    expect(placements.some((session) => session.project_id === foreign.id)).toBe(false);
  });

  it('never unarchives through polling and confirms missing state on two successful scans', async () => {
    const { f, catalogue, discover, setNative, setFail } = setup();
    const metadata: NativeConversation = {
      ref: 'native-two',
      cwd: f.repoPath,
      title: 'First title',
      parentRef: null,
      createdAt: null,
      updatedAt: '2026-08-21T00:00:00.000Z',
    };
    setNative([metadata]);
    catalogue.refreshProject(f.ids.project);
    await waitFor(() =>
      f.service.list().some((session) => session.agent_session_ref === metadata.ref),
    );
    const placement = f.service
      .list()
      .find((session) => session.agent_session_ref === metadata.ref)!;
    f.stores.sessions.setStatus(placement.id, 'archived');
    const changedProjects: string[][] = [];
    catalogue.on('sessions-changed', ({ projectIds }) => changedProjects.push(projectIds));

    setNative([{ ...metadata, title: 'Renamed natively' }]);
    catalogue.refreshProject(f.ids.project);
    await waitFor(
      () =>
        f.service.get(placement.id).agent_title === 'Renamed natively' &&
        changedProjects.some((projectIds) => projectIds.includes(f.ids.project)),
    );
    expect(f.service.get(placement.id).status).toBe('archived');
    expect(changedProjects.some((projectIds) => projectIds.includes(f.ids.project))).toBe(true);

    setNative([]);
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => f.stores.conversations.list()[0]?.missing_scan_count === 1);
    expect(f.service.get(placement.id).conversation_missing).not.toBe(true);

    // A failed pass never advances provisional deletion state.
    setFail(true);
    const calls = discover.mock.calls.length;
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => discover.mock.calls.length > calls);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.stores.conversations.list()[0]?.missing_scan_count).toBe(1);

    setFail(false);
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => f.service.get(placement.id).conversation_missing === true);
    setNative([{ ...metadata, title: 'Back again' }]);
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => f.service.get(placement.id).conversation_missing !== true);
    expect(f.service.get(placement.id).agent_title).toBe('Back again');
  });

  it('coalesces concurrent activation refreshes for one account', async () => {
    const { f, catalogue, discover, setNative, blockNext } = setup();
    setNative([]);
    const release = blockNext();
    catalogue.refreshProject(f.ids.project);
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => discover.mock.calls.length === 1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('debounces store events and schedules one short deletion verification', async () => {
    const { discover, triggerWatch } = setup({
      fakeClock: true,
      fakeWatch: 'healthy',
      timings: {
        healthySweepMs: 5 * 60_000,
        watchDebounceMs: 250,
        deletionVerifyMs: 1_500,
      },
    });
    triggerWatch();
    triggerWatch();
    triggerWatch();
    await vi.advanceTimersByTimeAsync(249);
    expect(discover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(discover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(discover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('runs the healthy safety sweep at five minutes and adaptively backs off failed watches', async () => {
    const healthy = setup({
      fakeClock: true,
      fakeWatch: 'healthy',
      timings: { healthySweepMs: 5 * 60_000 },
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(healthy.discover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(healthy.discover).toHaveBeenCalledTimes(1);
    healthy.catalogue.dispose();

    const fallback = setup({
      fakeClock: true,
      fakeWatch: 'failed',
      missingWatchRoot: true,
      timings: {
        healthySweepMs: 5 * 60_000,
        fallbackMinMs: 15_000,
        fallbackMaxMs: 5 * 60_000,
      },
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fallback.discover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fallback.discover).toHaveBeenCalledTimes(1);
    // First changed fingerprint keeps the minimum; then unchanged scans back
    // off to 30s and 60s rather than waking every 15s forever.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fallback.discover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fallback.discover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fallback.discover).toHaveBeenCalledTimes(3);
  });

  it('installs no watches without an eligible project and becomes eligible on unarchive', () => {
    const { f, catalogue, watchRoots } = setup({
      archiveProjectBeforeCatalogue: true,
      fakeWatch: 'healthy',
    });
    expect(watchRoots).not.toHaveBeenCalled();
    f.stores.projects.setArchived(f.ids.project, false);
    catalogue.reconcileWatchers();
    expect(watchRoots).toHaveBeenCalledTimes(1);
  });
});
