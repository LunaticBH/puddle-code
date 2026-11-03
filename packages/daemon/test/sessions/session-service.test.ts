import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeAdapter } from '../helpers/daemon-fixtures.js';
import { reconcilePass } from '../../src/sessions/reconcile.js';
import { fixture, waitFor } from '../helpers/daemon-fixtures.js';
import { sh } from '../helpers/git-fixtures.js';

/** A config dir carrying the fake adapter's logged-in marker. */
function credsDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `puddle-cfg-${label}-`));
  writeFileSync(join(dir, 'creds.json'), '{}');
  return dir;
}

describe('SessionService.create', () => {
  it('creates worktree, injects the onboarding preamble, reaches waiting_input', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'fix latency',
      prompt: 'make it faster',
    });
    expect(session.status).toMatch(/starting|running/);
    expect(session.branch).toBe('alice/fix-latency');
    expect(session.agent_session_ref).toBe(`fake-ref-${session.id}`);
    expect(existsSync(session.worktree_path)).toBe(true);
    expect(sh(session.worktree_path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'alice/fix-latency',
    );

    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('READY'));
    const output = f.logs.readTail(session.id, 'agent');
    expect(output).toContain('freshly created git worktree');
    expect(output).toContain('always run make setup'); // repo notes injected
    expect(output).toContain('make it faster'); // user prompt appended
    expect(output).toContain('skip=false');

    await waitFor(() => f.service.get(session.id).status === 'waiting_input');
    const statuses = f.stores.events.list(session.id).map((e) => e.type);
    expect(statuses).toContain('created');
    await f.service.kill(session.id);
  });

  it('rejects skip_permissions against a closed gate with 400', async () => {
    const f = fixture();
    await expect(
      f.service.create({
        project_id: f.ids.project,
        account_id: f.ids.account,
        skip_permissions: true,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'skip_permissions_denied' });
  });

  it('honours skip_permissions when gate and account opt-in are both on', async () => {
    const f = fixture();
    f.stores.profiles.patchSettings(f.ids.profile, { allowSkipPermissions: true });
    const account2 = f.stores.accounts.create({
      profile_id: f.ids.profile,
      agent_type: 'fake',
      label: 'yolo',
      config_dir: credsDir('yolo'),
      skip_permissions_default: true,
    });
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: account2.id,
      title: 'trusted',
      skip_permissions: true,
    });
    expect(session.skip_permissions).toBe(true);
    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('skip=true'));
    await f.service.kill(session.id);
  });

  it('rejects an account from another profile', async () => {
    const f = fixture();
    const bob = f.stores.profiles.create({ name: 'bob', branch_prefix: 'bob/' });
    const bobAccount = f.stores.accounts.create({
      profile_id: bob.id,
      agent_type: 'fake',
      label: 'personal',
      config_dir: '/tmp/bob-cfg',
      skip_permissions_default: false,
    });
    await expect(
      f.service.create({ project_id: f.ids.project, account_id: bobAccount.id }),
    ).rejects.toMatchObject({ code: 'foreign_account' });
  });

  it('serialises minted ref capture so concurrent launches cannot claim the same conversation', async () => {
    const nativeRefs: string[] = [];
    let nextRef = 0;
    const adapter = {
      ...fakeAdapter(),
      capabilities: {
        ...fakeAdapter().capabilities,
        presetSessionId: false,
      },
      existingSessionRefs: () => new Set(nativeRefs),
      resolveSessionRef: async (
        _opts: Parameters<ReturnType<typeof fakeAdapter>['resolveSessionRef']>[0],
        _account: Parameters<ReturnType<typeof fakeAdapter>['resolveSessionRef']>[1],
        excluded = new Set<string>(),
      ) => {
        nativeRefs.push(`minted-${++nextRef}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [...nativeRefs].reverse().find((ref) => !excluded.has(ref))!;
      },
    };
    const f = fixture({ adapter });
    const create = (title: string) =>
      f.service.create({
        project_id: f.ids.project,
        account_id: f.ids.account,
        title,
        separate_branch: false,
        separate_worktree: false,
      });
    const [first, second] = await Promise.all([create('first'), create('second')]);

    // Creation does not wait for either native id. The serialised background
    // tasks still give each puddle session exactly one distinct conversation.
    expect(first.agent_session_ref).toBeNull();
    expect(second.agent_session_ref).toBeNull();
    await waitFor(
      () =>
        f.service.get(first.id).agent_session_ref !== null &&
        f.service.get(second.id).agent_session_ref !== null,
    );
    expect(
      new Set([
        f.service.get(first.id).agent_session_ref,
        f.service.get(second.id).agent_session_ref,
      ]),
    ).toEqual(new Set(['minted-1', 'minted-2']));
    await Promise.all([f.service.kill(first.id), f.service.kill(second.id)]);
  });

  it('returns before minted ref discovery finishes, then stores the ref and tracks its name', async () => {
    let finishDiscovery: ((ref: string) => void) | undefined;
    const names = new Map<string, string>();
    const adapter = {
      ...fakeAdapter(),
      capabilities: { ...fakeAdapter().capabilities, presetSessionId: false },
      existingSessionRefs: () => new Set<string>(),
      resolveSessionRef: () =>
        new Promise<string>((resolve) => {
          finishDiscovery = resolve;
        }),
      sessionTitle: (ref: string) => names.get(ref) ?? null,
    };
    const f = fixture({ adapter, titleRefreshMs: 20 });
    const session = await Promise.race([
      f.service.create({
        project_id: f.ids.project,
        account_id: f.ids.account,
        title: 'async ref',
        separate_branch: false,
        separate_worktree: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('session creation waited for ref discovery')), 5_000),
      ),
    ]);

    expect(session.agent_session_ref).toBeNull();
    await waitFor(() => finishDiscovery !== undefined);
    names.set('minted-ref', 'Codex opening name');
    finishDiscovery?.('minted-ref');
    await waitFor(() => f.service.get(session.id).agent_session_ref === 'minted-ref');
    await waitFor(() => f.service.get(session.id).agent_title === 'Codex opening name');

    // The UUID is stable; a Codex rename updates only its indexed name.
    names.set('minted-ref', 'Codex renamed session');
    await waitFor(() => f.service.get(session.id).agent_title === 'Codex renamed session');
    expect(f.service.get(session.id).agent_session_ref).toBe('minted-ref');
    await f.service.kill(session.id);
  });

  it('returns before a minted-id account snapshot finishes, then spawns from that snapshot', async () => {
    let finishSnapshot: ((refs: ReadonlySet<string>) => void) | undefined;
    const adapter = {
      ...fakeAdapter(),
      capabilities: { ...fakeAdapter().capabilities, presetSessionId: false },
      existingSessionRefs: () =>
        new Promise<ReadonlySet<string>>((resolve) => {
          finishSnapshot = resolve;
        }),
      resolveSessionRef: async () => 'minted-after-snapshot',
    };
    const f = fixture({ adapter });
    const session = await Promise.race([
      f.service.create({
        project_id: f.ids.project,
        account_id: f.ids.account,
        title: 'async snapshot',
        separate_branch: false,
        separate_worktree: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('session creation waited for account snapshot')), 5_000),
      ),
    ]);

    expect(session.agent_session_ref).toBeNull();
    expect(f.ptys.has(session.id, 'agent')).toBe(false);
    await waitFor(() => finishSnapshot !== undefined);
    finishSnapshot?.(new Set());
    await waitFor(() => f.service.get(session.id).agent_session_ref === 'minted-after-snapshot');
    expect(f.ptys.has(session.id, 'agent')).toBe(true);
    await f.service.kill(session.id);
  });

  it('captures a minted ref later when launch-time discovery returned unresolved', async () => {
    let visibleRef: string | null = null;
    const adapter = {
      ...fakeAdapter(),
      capabilities: { ...fakeAdapter().capabilities, presetSessionId: false },
      existingSessionRefs: () => new Set<string>(),
      resolveSessionRef: async (opts: { sessionId: string }) => opts.sessionId,
      discoverSessionRef: () => visibleRef,
      sessionRefMatches: (ref: string) => ref === visibleRef,
    };
    const f = fixture({ adapter, titleRefreshMs: 20 });
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'late ref',
      separate_branch: false,
      separate_worktree: false,
    });
    expect(session.agent_session_ref).toBeNull();

    visibleRef = 'minted-later';
    await waitFor(() => f.service.get(session.id).agent_session_ref === visibleRef);
    expect(
      f.stores.events.list(session.id).find((event) => event.type === 'session_ref_captured')
        ?.payload,
    ).toMatchObject({ ref: 'minted-later', source: 'late' });
    await f.service.kill(session.id);
  });
});

describe('kill / resume / archive lifecycle', () => {
  it('kill → exited; resume replays the ref; archive is a reversible hide (worktree kept)', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'lifecycle',
    });
    await waitFor(() => f.service.get(session.id).status !== 'starting');
    const killed = await f.service.kill(session.id);
    expect(killed.status).toBe('exited');

    const resumed = await f.service.resume(session.id);
    expect(resumed.status).toBe('running');
    await waitFor(() =>
      f.logs.readTail(session.id, 'agent').includes(`RESUME ref=fake-ref-${session.id}`),
    );
    // resume of an exited (not interrupted) session carries no injected note
    expect(f.logs.readTail(session.id, 'agent')).toContain('PROMPT<<>>');

    await f.service.kill(session.id);
    // Archive keeps the worktree, branch, and logs — nothing is destroyed.
    const archived = await f.service.archive(session.id);
    expect(archived.status).toBe('archived');
    expect(existsSync(session.worktree_path)).toBe(true);
    expect(sh(f.repoPath, 'branch', '--list', 'alice/lifecycle')).toContain('alice/lifecycle');
    expect(f.logs.readTail(session.id, 'agent')).not.toBe('');

    // Unarchive brings it back resumable while the worktree survives.
    const unarchived = await f.service.unarchive(session.id);
    expect(unarchived.status).toBe('exited');
    expect(unarchived.worktree_missing).toBeUndefined();
    const reresumed = await f.service.resume(session.id);
    expect(reresumed.status).toBe('running');
    await f.service.kill(session.id);
  });

  it('injects the interrupted note when resuming an interrupted session', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'interrupted',
    });
    await f.service.kill(session.id);
    f.stores.sessions.setStatus(session.id, 'interrupted'); // simulate reconcile
    await f.service.resume(session.id);
    await waitFor(() =>
      f.logs.readTail(session.id, 'agent').includes('This session has been resumed'),
    );
    await f.service.kill(session.id);
  });

  it('repairs a real but mismatched minted ref before resume', async () => {
    const adapter = {
      ...fakeAdapter(),
      capabilities: {
        ...fakeAdapter().capabilities,
        presetSessionId: false,
      },
      hasConversation: (ref: string) => ref === 'wrong-ref' || ref === 'right-ref',
      sessionRefMatches: (ref: string) => ref === 'right-ref',
      discoverSessionRef: () => 'right-ref',
    };
    const f = fixture({ adapter });
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'repair me',
    });
    await f.service.kill(session.id);
    f.stores.sessions.setAgentSessionRef(session.id, 'wrong-ref');
    f.stores.sessions.setStatus(session.id, 'interrupted');

    await f.service.resume(session.id);
    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('RESUME ref=right-ref'));
    expect(f.service.get(session.id).agent_session_ref).toBe('right-ref');
    expect(
      f.stores.events.list(session.id).find((event) => event.type === 'session_ref_recovered')
        ?.payload,
    ).toMatchObject({
      previous_ref: 'wrong-ref',
      ref: 'right-ref',
      reason: 'mismatched',
    });
    await f.service.kill(session.id);
  });

  it('validates a catalogue-linked ref against its native creation time', async () => {
    const nativeCreatedAt = '2026-07-01T10:00:05.000Z';
    const adapter = {
      ...fakeAdapter(),
      sessionRefMatches: (_ref: string, context: { nativeCreatedAt?: string }) =>
        context.nativeCreatedAt === nativeCreatedAt,
    };
    const f = fixture({ adapter });
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'catalogue timestamp',
    });
    await waitFor(() => f.service.get(session.id).agent_session_ref !== null);
    await f.service.kill(session.id);
    const captured = f.service.get(session.id);
    f.stores.conversations.upsert(f.ids.profile, adapter.id, f.ids.account, {
      ref: captured.agent_session_ref!,
      cwd: captured.worktree_path,
      createdAt: nativeCreatedAt,
    });

    await f.service.resume(session.id);
    await waitFor(() =>
      f.logs.readTail(session.id, 'agent').includes(`RESUME ref=${captured.agent_session_ref}`),
    );
    await f.service.kill(session.id);
  });

  it('releases a legacy wrong owner before reclaiming the correct ref', async () => {
    const ownership = new Map<string, string>();
    const adapter = {
      ...fakeAdapter(),
      capabilities: {
        ...fakeAdapter().capabilities,
        presetSessionId: false,
      },
      hasConversation: () => true,
      sessionRefMatches: (ref: string, context: { sessionId: string }) =>
        ownership.get(context.sessionId) === ref,
      discoverSessionRef: (
        _worktree: string,
        _account: unknown,
        context?: { sessionId: string },
      ) => (context === undefined ? null : (ownership.get(context.sessionId) ?? null)),
    };
    const f = fixture({ adapter });
    const first = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'first owner',
    });
    const second = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'second owner',
    });
    await waitFor(
      () =>
        f.service.get(first.id).agent_session_ref !== null &&
        f.service.get(second.id).agent_session_ref !== null,
    );
    ownership.set(first.id, f.service.get(first.id).agent_session_ref!);
    ownership.set(second.id, f.service.get(second.id).agent_session_ref!);
    await Promise.all([f.service.kill(first.id), f.service.kill(second.id)]);

    // Legacy cross-wire: first occupies second's ref while second is blank.
    f.stores.sessions.setAgentSessionRef(second.id, null);
    f.stores.sessions.setAgentSessionRef(first.id, ownership.get(second.id)!);
    await f.service.resume(second.id);
    expect(f.service.get(second.id).agent_session_ref).toBe(ownership.get(second.id));
    expect(f.service.get(first.id).agent_session_ref).toBeNull();
    expect(
      f.stores.events.list(first.id).some((event) => event.type === 'session_ref_invalidated'),
    ).toBe(true);
    await f.service.kill(second.id);

    // The invalidated row can then recover its own untouched conversation.
    await f.service.resume(first.id);
    expect(f.service.get(first.id).agent_session_ref).toBe(ownership.get(first.id));
    await f.service.kill(first.id);
  });

  it('downgrades skip on resume when the gate closed, with a terminal note', async () => {
    const f = fixture();
    f.stores.profiles.patchSettings(f.ids.profile, { allowSkipPermissions: true });
    const account = f.stores.accounts.create({
      profile_id: f.ids.profile,
      agent_type: 'fake',
      label: 'yolo2',
      config_dir: credsDir('yolo2'),
      skip_permissions_default: true,
    });
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: account.id,
      title: 'gated',
      skip_permissions: true,
    });
    await f.service.kill(session.id);
    f.stores.profiles.patchSettings(f.ids.profile, { allowSkipPermissions: false }); // gate closes
    const resumed = await f.service.resume(session.id);
    expect(resumed.skip_permissions).toBe(false);
    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('skip=false'));
    expect(f.logs.readTail(session.id, 'agent')).toContain('skip-permissions no longer permitted');
    await f.service.kill(session.id);
  });

  it('hook signals drive status and mute the regex detector (SPEC §4)', async () => {
    const f = fixture();
    f.service.setSignalPort(65432); // pretend the daemon bound — enables nonce minting
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'signalled',
    });
    // Pre-signal, the regex fallback still works: READY → waiting_input.
    await waitFor(() => f.service.get(session.id).status === 'waiting_input');

    const nonce = f.service.signalNonceFor(session.id);
    expect(nonce).toBeTruthy();
    expect(f.service.signalAgentStatus('not-a-real-nonce', 'working')).toBe(false);

    // The first hook signal takes over: working → running…
    expect(f.service.signalAgentStatus(nonce!, 'working')).toBe(true);
    expect(f.service.get(session.id).status).toBe('running');
    // …and the detector is muted from here on: fresh output re-matches READY
    // in the rolling tail, but the flip back to waiting_input never fires.
    f.ptys.write(session.id, 'agent', 'poke\n');
    await new Promise((r) => setTimeout(r, 400)); // > quietMs (150) with margin
    expect(f.service.get(session.id).status).toBe('running');

    // The hook remains authoritative in the other direction too.
    expect(f.service.signalAgentStatus(nonce!, 'waiting_input')).toBe(true);
    expect(f.service.get(session.id).status).toBe('waiting_input');

    // The nonce dies with the PTY.
    await f.service.kill(session.id);
    expect(f.service.signalAgentStatus(nonce!, 'working')).toBe(false);
  });

  it('accepts an authoritative waiting hook before the first PTY output', async () => {
    const f = fixture({ agentStartDelayMs: 500 });
    f.service.setSignalPort(65432);
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'early signal',
    });
    expect(f.service.get(session.id).status).toBe('starting');

    const nonce = f.service.signalNonceFor(session.id);
    expect(nonce).toBeTruthy();
    expect(f.service.signalAgentStatus(nonce!, 'waiting_input')).toBe(true);
    expect(f.service.get(session.id).status).toBe('waiting_input');

    // The delayed first draw must not overwrite the hook-owned idle state.
    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('READY'));
    expect(f.service.get(session.id).status).toBe('waiting_input');
    await f.service.kill(session.id);
  });

  it('archives a live session by killing it first — one gesture, still reversible', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'live',
    });
    const archived = await f.service.archive(session.id);
    expect(archived.status).toBe('archived');
    // Re-archiving is an idempotent hide, and the kill was not a teardown:
    // unarchive brings the session back resumable.
    expect((await f.service.archive(session.id)).status).toBe('archived');
    expect((await f.service.unarchive(session.id)).status).toBe('exited');
    await f.service.archive(session.id); // leave it hidden for the fixture teardown
  });

  it('archives a dirty worktree without complaint, keeping its uncommitted changes', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'dirty',
    });
    await f.service.kill(session.id);
    writeFileSync(join(session.worktree_path, 'uncommitted.txt'), 'x');
    // Archive no longer removes the worktree, so a dirty tree is safe — no force,
    // no prompt, and the uncommitted file survives.
    const archived = await f.service.archive(session.id);
    expect(archived.status).toBe('archived');
    expect(existsSync(join(session.worktree_path, 'uncommitted.txt'))).toBe(true);
  });

  it('unarchive of a session whose worktree is gone returns it for history only', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'gone',
    });
    await f.service.kill(session.id);
    await f.service.archive(session.id);
    // The worktree is pruned out-of-band (e.g. via the Worktrees manager).
    rmSync(session.worktree_path, { recursive: true, force: true });
    const unarchived = await f.service.unarchive(session.id);
    expect(unarchived.status).toBe('exited');
    expect(unarchived.worktree_missing).toBe(true);
    // Resume is refused — there is no worktree to run in (history only).
    await expect(f.service.resume(session.id)).rejects.toMatchObject({ code: 'worktree_missing' });
  });

  it('archiveProject refuses live sessions unless forced', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'proj',
    });
    await expect(f.service.archiveProject(f.ids.project)).rejects.toMatchObject({
      code: 'project_live',
    });
    await f.service.archiveProject(f.ids.project, true);
    expect(f.service.get(session.id).status).toBe('archived');
  });
});

describe('shells', () => {
  it('spawns numbered shells in the worktree', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'shells',
    });
    const term = f.service.spawnShell(session.id);
    expect(term).toBe('shell-1');
    f.ptys.write(session.id, term, 'pwd\n');
    await waitFor(() => f.logs.readTail(session.id, term).includes(session.worktree_path));
    expect(f.service.spawnShell(session.id)).toBe('shell-2');
    await f.service.kill(session.id);
  });
});

describe('native conversation lifecycle', () => {
  it('falls back to the direct launch when an adapter lifecycle channel cannot start', async () => {
    const adapter = {
      ...fakeAdapter(),
      prepareLifecycleLaunch: async () => {
        throw new Error('unsupported agent version');
      },
    };
    const f = fixture({ adapter });
    f.service.setSignalPort(65432);
    const notices: Array<{ title: string }> = [];
    f.service.on('notice', (event) => notices.push(event));
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('LAUNCH'));
    expect(f.service.get(session.id).native_sync).toBe('fallback');
    expect(notices).toContainEqual(
      expect.objectContaining({ title: 'Conversation switching is not synchronised' }),
    );
    await f.service.kill(session.id);
  });

  it('marks a hook launch fallback when the installed agent version is unsupported', async () => {
    const adapter = {
      ...fakeAdapter(),
      lifecycleSignals: true,
      checkLifecycleSupport: async () => false,
    };
    const f = fixture({ adapter });
    f.service.setSignalPort(65432);
    const notices: Array<{ title: string }> = [];
    f.service.on('notice', (event) => notices.push(event));
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('LAUNCH'));
    expect(f.service.get(session.id).native_sync).toBe('fallback');
    expect(notices).toContainEqual(
      expect.objectContaining({ title: 'Conversation switching is not synchronised' }),
    );
    await f.service.kill(session.id);
  });

  it('rebinds one stable runtime, its shells, history segments, and branch ownership', async () => {
    const f = fixture({ adapter: { ...fakeAdapter(), lifecycleSignals: true } });
    f.service.setSignalPort(65432);
    const source = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'source overlay',
    });
    await waitFor(() => f.service.get(source.id).status === 'waiting_input');
    const shell = f.service.spawnShell(source.id);
    const originalPids = f.ptys.pidsFor(source.id).sort((a, b) => a - b);
    const nonce = f.service.signalNonceFor(source.id)!;
    const switched: Array<{ targetSession: string; outcome: string }> = [];
    f.service.on('session-switched', (event) => switched.push(event));

    expect(
      await f.service.signalAgentLifecycle({
        nonce,
        event: 'session_start',
        agent_session_ref: 'native-clear-ref',
        cwd: '/native/recorded/cwd',
        source: 'clear',
      }),
    ).toBe(true);

    const target = f.service
      .list()
      .find((session) => session.agent_session_ref === 'native-clear-ref');
    expect(target).toBeDefined();
    expect(target!.id).not.toBe(source.id);
    expect(target!.worktree_path).toBe(source.worktree_path);
    expect(target!.native_sync).toBe('full');
    expect(f.service.get(source.id)).toMatchObject({ status: 'exited', branch_owner: false });
    expect(f.service.get(target!.id).branch_owner).toBe(true);
    expect(f.ptys.pidsFor(target!.id).sort((a, b) => a - b)).toEqual(originalPids);
    expect(f.ptys.liveTerms(target!.id)).toContain(shell);
    expect(f.ptys.liveTerms(source.id)).toEqual([]);
    expect(switched).toContainEqual(
      expect.objectContaining({ targetSession: target!.id, outcome: 'rebound' }),
    );
    expect(f.stores.conversations.get(target!.conversation_id!)?.native_cwd).toBe(
      '/native/recorded/cwd',
    );

    // Regex-only status adapters must follow the runtime rather than keeping a
    // spawn-time closure over the frozen source placement.
    f.ptys.write(target!.id, 'agent', 'BUSY-MARKER\n');
    await waitFor(() => f.service.get(target!.id).status === 'running');
    f.ptys.write(target!.id, 'agent', 'READY\n');
    await waitFor(() => f.service.get(target!.id).status === 'waiting_input');

    f.ptys.write(target!.id, 'agent', 'after-switch\n');
    await waitFor(() => f.logs.readTail(target!.id, 'agent').includes('after-switch'));
    expect(f.logs.readTail(source.id, 'agent')).not.toContain('after-switch');

    // Compact keeps this same placement and runtime identity.
    await f.service.signalAgentLifecycle({
      nonce,
      event: 'session_start',
      agent_session_ref: 'native-clear-ref',
      cwd: target!.worktree_path,
      source: 'compact',
    });
    expect(f.service.signalNonceFor(target!.id)).toBe(nonce);

    // Fork creates another placement and records the native parent.
    await f.service.signalAgentLifecycle({
      nonce,
      event: 'session_start',
      agent_session_ref: 'native-fork-ref',
      cwd: target!.worktree_path,
      source: 'fork',
    });
    const forked = f.service
      .list()
      .find((session) => session.agent_session_ref === 'native-fork-ref');
    expect(forked?.parent_conversation_id).toBe(target!.conversation_id);
    await f.service.kill(forked!.id);
  });

  it('unarchives an existing placement only on an exact native resume', async () => {
    const f = fixture({ adapter: { ...fakeAdapter(), lifecycleSignals: true } });
    f.service.setSignalPort(65432);
    const source = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'live source',
    });
    await waitFor(() => f.service.get(source.id).status === 'waiting_input');
    const conversation = f.stores.conversations.upsert(
      f.ids.profile,
      source.agent_type!,
      f.ids.account,
      {
        ref: 'archived-native-ref',
        cwd: '/native/old/worktree',
        title: 'Native label',
      },
    );
    const target = f.stores.sessions.create({
      id: 'a2f0c9d4-1111-4222-8333-444455556666',
      project_id: source.project_id,
      account_id: source.account_id,
      conversation_id: conversation.id,
      worktree_path: source.worktree_path,
      base_branch: source.base_branch,
      branch: source.branch,
      separate_branch: source.separate_branch,
      kind: 'agent',
      agent_type: source.agent_type,
      title: 'keep this placement title',
      status: 'archived',
      skip_permissions: false,
    });

    await f.service.signalAgentLifecycle({
      nonce: f.service.signalNonceFor(source.id)!,
      event: 'session_start',
      agent_session_ref: conversation.agent_session_ref,
      cwd: source.worktree_path,
      source: 'resume',
    });

    expect(f.service.get(source.id).status).toBe('exited');
    expect(f.service.get(target.id)).toMatchObject({
      status: 'waiting_input',
      title: 'keep this placement title',
      native_sync: 'full',
      branch_owner: true,
    });
    await f.service.kill(target.id);
  });

  it('serialises simultaneous switches and leaves one live placement', async () => {
    const f = fixture({ adapter: { ...fakeAdapter(), lifecycleSignals: true } });
    f.service.setSignalPort(65432);
    const source = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    await waitFor(() => f.service.get(source.id).status === 'waiting_input');
    const nonce = f.service.signalNonceFor(source.id)!;

    await Promise.all([
      f.service.signalAgentLifecycle({
        nonce,
        event: 'session_start',
        agent_session_ref: 'simultaneous-a',
        cwd: source.worktree_path,
        source: 'clear',
      }),
      f.service.signalAgentLifecycle({
        nonce,
        event: 'session_start',
        agent_session_ref: 'simultaneous-b',
        cwd: source.worktree_path,
        source: 'clear',
      }),
    ]);

    const live = f.service
      .list()
      .filter((session) => ['starting', 'running', 'waiting_input'].includes(session.status));
    expect(live).toHaveLength(1);
    expect(live[0]?.agent_session_ref).toBe('simultaneous-b');
    expect(f.ptys.liveCount()).toBe(1);
    await f.service.kill(live[0]!.id);
  });

  it('stops a competing switch and identifies the already-live placement to REST callers', async () => {
    const f = fixture({ adapter: { ...fakeAdapter(), lifecycleSignals: true } });
    f.service.setSignalPort(65432);
    const first = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'first',
    });
    const second = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'second',
    });
    await waitFor(() => f.service.get(first.id).status === 'waiting_input');
    await waitFor(() => f.service.get(second.id).status === 'waiting_input');
    const events: Array<{ sourceSession: string; targetSession: string; outcome: string }> = [];
    f.service.on('session-switched', (event) => events.push(event));

    await f.service.signalAgentLifecycle({
      nonce: f.service.signalNonceFor(first.id)!,
      event: 'session_start',
      agent_session_ref: second.agent_session_ref!,
      cwd: first.worktree_path,
      source: 'resume',
    });
    await waitFor(() => !f.ptys.has(first.id, 'agent'));
    expect(events).toContainEqual({
      sourceSession: first.id,
      targetSession: second.id,
      targetProject: second.project_id,
      cause: 'resume',
      outcome: 'focused-existing',
    });
    expect(f.service.get(second.id).status).toBe('waiting_input');

    const otherProject = f.stores.projects.create({
      profile_id: f.ids.profile,
      repo_id: f.ids.repo,
      name: 'other placement',
    });
    const duplicate = f.stores.sessions.create({
      id: 'd2f0c9d4-1111-4222-8333-444455556666',
      project_id: otherProject.id,
      account_id: f.ids.account,
      conversation_id: second.conversation_id,
      worktree_path: second.worktree_path,
      base_branch: second.base_branch,
      branch: second.branch,
      separate_branch: second.separate_branch,
      kind: 'agent',
      agent_type: second.agent_type,
      title: 'duplicate',
      status: 'exited',
      skip_permissions: false,
    });
    await expect(f.service.resume(duplicate.id)).rejects.toMatchObject({
      code: 'conversation_live',
      details: {
        existing_session_id: second.id,
        existing_project_id: second.project_id,
      },
    });
    await f.service.kill(second.id);
  });
});

describe('reconcile', () => {
  it('marks live-status sessions interrupted on boot', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'reconcile',
    });
    await f.service.kill(session.id);
    f.stores.sessions.setStatus(session.id, 'running'); // pretend the daemon died mid-flight
    const result = reconcilePass({
      sessions: f.stores.sessions,
      events: f.stores.events,
      projects: f.stores.projects,
      onboarding: f.onboarding,
    });
    expect(result.interrupted).toEqual([session.id]);
    expect(f.service.get(session.id).status).toBe('interrupted');
    expect(f.stores.events.list(session.id).map((e) => e.type)).toContain('interrupted');
  });
});

describe('onboarding notes sync', () => {
  it('syncs .puddle/onboarding-notes.md into repos.onboarding_notes with a previous-notes event', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'notes',
    });
    writeFileSync(
      join(session.worktree_path, '.puddle', 'onboarding-notes.md'),
      'always run make setup\nnever install playwright browsers\n',
    );
    await waitFor(() =>
      (f.stores.repos.get(f.ids.repo).onboarding_notes ?? '').includes('playwright'),
    );
    const events = f.stores.events.list(session.id);
    const sync = events.find((e) => e.type === 'onboarding_notes_updated');
    expect(sync?.payload).toEqual({ previous: 'always run make setup' });
    await f.service.kill(session.id);
  });
});

describe('session naming', () => {
  it("adopts the agent's own name as agent_title and broadcasts the change", async () => {
    const f = fixture();
    const renames: Array<{ title: string | null; agent_title: string | null }> = [];
    f.service.on('renamed', (e) => renames.push(e));
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      prompt: 'go',
    });
    // The fake agent names its session; the daemon picks it up on the next
    // status change (the waiting_input flip carries a quiet window, so the file
    // is in place by the time the refresh runs).
    const cfg = f.stores.accounts.get(f.ids.account).config_dir;
    writeFileSync(join(cfg, `title-${session.agent_session_ref}`), 'named by the agent');
    await waitFor(() => f.service.get(session.id).agent_title === 'named by the agent');
    expect(f.service.get(session.id).title).toBeNull(); // no user override
    expect(renames.some((e) => e.agent_title === 'named by the agent')).toBe(true);
    await f.service.kill(session.id);
  });

  it('re-reads the agent name on an OSC title emission, without a status change', async () => {
    const f = fixture();
    const renames: Array<{ agent_title: string | null }> = [];
    f.service.on('renamed', (e) => renames.push(e));
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      prompt: 'go',
    });
    // Settle into a steady live state (READY → waiting_input) with no name yet.
    await waitFor(() => f.service.get(session.id).status === 'waiting_input');
    expect(f.service.get(session.id).agent_title).toBeNull();

    // The agent renames itself mid-session — as Claude Code's `/rename` does,
    // entirely client-side: it rewrites its own title source and sets the
    // terminal title, with no status transition. The OSC title reaching the PTY
    // stream is the only signal the daemon gets.
    const cfg = f.stores.accounts.get(f.ids.account).config_dir;
    writeFileSync(join(cfg, `title-${session.agent_session_ref}`), 'renamed live');
    f.ptys.emit('data', {
      stream: session.id,
      term: 'agent',
      data: '\u001b]0;⠻ renamed live\u0007',
    });

    await waitFor(() => f.service.get(session.id).agent_title === 'renamed live');
    expect(f.service.get(session.id).title).toBeNull(); // still no user override
    expect(renames.some((e) => e.agent_title === 'renamed live')).toBe(true);
    await f.service.kill(session.id);
  });

  it('picks up an idle in-agent rename via the periodic re-read (no OSC, no status change)', async () => {
    const f = fixture({ titleRefreshMs: 20 });
    const renames: Array<{ agent_title: string | null }> = [];
    f.service.on('renamed', (e) => renames.push(e));
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      prompt: 'go',
    });
    await waitFor(() => f.service.get(session.id).status === 'waiting_input');
    expect(f.service.get(session.id).agent_title).toBeNull();

    // The agent renames itself while idle — no OSC escape, no status change. Only
    // the periodic re-read can catch this (the reliable path for claude-code's
    // `/rename`).
    const cfg = f.stores.accounts.get(f.ids.account).config_dir;
    writeFileSync(join(cfg, `title-${session.agent_session_ref}`), 'renamed while idle');
    await waitFor(() => f.service.get(session.id).agent_title === 'renamed while idle');
    expect(renames.some((e) => e.agent_title === 'renamed while idle')).toBe(true);
    await f.service.kill(session.id);
  });

  it('captures the terminal-title "sequence" name (osc_title) and de-animates it', async () => {
    const f = fixture();
    const renames: Array<{ osc_title?: string | null }> = [];
    f.service.on('renamed', (e) => renames.push(e));
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      prompt: 'go',
    });
    await waitFor(() => f.service.get(session.id).status === 'waiting_input');
    expect(f.service.get(session.id).osc_title ?? null).toBeNull();

    // The process sets its terminal title with an animated spinner prefix. The
    // daemon stores the de-animated name; successive spinner frames of the same
    // name are one stored value and one broadcast, not one per frame.
    f.ptys.emit('data', {
      stream: session.id,
      term: 'agent',
      data: '\u001b]0;⠋ my terminal\u0007',
    });
    await waitFor(() => f.service.get(session.id).osc_title === 'my terminal');
    f.ptys.emit('data', {
      stream: session.id,
      term: 'agent',
      data: '\u001b]0;⠙ my terminal\u0007',
    });
    expect(renames.filter((e) => e.osc_title === 'my terminal')).toHaveLength(1);
    await f.service.kill(session.id);
  });

  it('rename stores a user override; an empty rename clears it back to the default', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    f.service.rename(session.id, 'my session');
    expect(f.service.get(session.id).title).toBe('my session');
    // Empty (or whitespace) clears the override so the name reverts to
    // agent_title (then the id prefix).
    f.service.rename(session.id, '   ');
    expect(f.service.get(session.id).title).toBeNull();
    await f.service.kill(session.id);
  });
});

describe('captured env', () => {
  const delta = (stream: string, name: string, value?: string, op: 'set' | 'unset' = 'set') => ({
    stream,
    term: 'shell-1',
    delta: op === 'set' ? { op, name, value } : { op, name },
  });

  async function liveSession(f: ReturnType<typeof fixture>) {
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    await waitFor(() => f.service.get(session.id).status !== 'starting');
    return session;
  }

  it('consumes deltas per-variable: last write wins, unset removes, unowned unset is a no-op', async () => {
    const f = fixture();
    const session = await liveSession(f);
    f.ptys.emit('env-delta', delta(session.id, 'MY_TOKEN', 'first'));
    f.ptys.emit('env-delta', delta(session.id, 'MY_TOKEN', 'second'));
    f.ptys.emit('env-delta', delta(session.id, 'KEEP', 'kept'));
    expect(f.stores.sessions.getEnv(session.id)).toEqual({ MY_TOKEN: 'second', KEEP: 'kept' });
    f.ptys.emit('env-delta', delta(session.id, 'MY_TOKEN', undefined, 'unset'));
    f.ptys.emit('env-delta', delta(session.id, 'NEVER_OWNED', undefined, 'unset'));
    expect(f.stores.sessions.getEnv(session.id)).toEqual({ KEEP: 'kept' });
    await f.service.kill(session.id);
  });

  it('returns captured values and byte sizes in name order for the cockpit', async () => {
    const f = fixture();
    const session = await liveSession(f);
    f.stores.sessions.mergeEnv(session.id, { ZED: 'plain', ALPHA: 'a\n✓' }, []);
    expect(f.service.capturedEnv(session.id)).toEqual({
      vars: [
        { name: 'ALPHA', value: 'a\n✓', bytes: 5 },
        { name: 'ZED', value: 'plain', bytes: 5 },
      ],
    });
    await f.service.kill(session.id);
  });

  it('ignores denylisted names, unknown streams, and hook-control vars', async () => {
    const f = fixture();
    const session = await liveSession(f);
    f.ptys.emit('env-delta', delta(session.id, 'PWD', '/evil'));
    f.ptys.emit('env-delta', delta(session.id, 'PUDDLE_ANYTHING', 'x'));
    // Non-session streams (home terminal, login PTYs) must not throw or write.
    f.ptys.emit('env-delta', delta('home', 'HOME_VAR', 'x'));
    f.ptys.emit('env-delta', delta('login-3', 'LOGIN_VAR', 'x'));
    expect(f.stores.sessions.getEnv(session.id)).toEqual({});
    await f.service.kill(session.id);
  });

  it('enforces value and count caps with a one-time terminal note', async () => {
    const f = fixture();
    const session = await liveSession(f);
    const huge = 'v'.repeat(32 * 1024 + 1);
    f.ptys.emit('env-delta', delta(session.id, 'HUGE', huge));
    f.ptys.emit('env-delta', delta(session.id, 'HUGE', huge));
    expect(f.stores.sessions.getEnv(session.id)).toEqual({});
    const log = f.logs.readTail(session.id, 'shell-1');
    expect(log.split('HUGE not persisted').length).toBe(2); // exactly one note

    const many = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`VAR_${i}`, 'x']));
    f.stores.sessions.mergeEnv(session.id, many, []);
    f.ptys.emit('env-delta', delta(session.id, 'ONE_TOO_MANY', 'x'));
    expect(f.stores.sessions.getEnv(session.id)['ONE_TOO_MANY']).toBeUndefined();
    // Updates to an already-captured name are always accepted at the cap.
    f.ptys.emit('env-delta', delta(session.id, 'VAR_0', 'updated'));
    expect(f.stores.sessions.getEnv(session.id)['VAR_0']).toBe('updated');
    await f.service.kill(session.id);
  });

  it('injects captured env on resume; adapter env wins over a captured clash', async () => {
    const f = fixture();
    const session = await liveSession(f);
    await f.service.kill(session.id);
    f.stores.sessions.mergeEnv(
      session.id,
      { CAPTURED_PROBE: 'hello-from-capture', FAKE_CONFIG_DIR: '/evil' },
      [],
    );
    await f.service.resume(session.id);
    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('ENVPROBE<<'));
    const log = f.logs.readTail(session.id, 'agent');
    expect(log).toContain('ENVPROBE<<hello-from-capture>>');
    expect(log).not.toContain('CFG<</evil>>'); // adapter env is sacrosanct
    await f.service.kill(session.id);
  });

  it('spawnShell passes captured env and the hook spawn config', async () => {
    const spawnConfigCalls: Array<{
      shell: string;
      session?: { captureEnv: boolean; historyFile: string };
    }> = [];
    const stubHooks = {
      spawnConfig: (shell: string, session?: { captureEnv: boolean; historyFile: string }) => {
        spawnConfigCalls.push({ shell, session });
        return { args: [], env: { PUDDLE_HOOK_MARKER: '1' } };
      },
    } as unknown as import('../../src/pty/shell-hooks.js').ShellHooks;
    const f = fixture({ shellHooks: stubHooks });
    const session = await liveSession(f);
    f.stores.sessions.mergeEnv(session.id, { CAPTURED_PROBE: 'shell-sees-me' }, []);
    const term = f.service.spawnShell(session.id);
    expect(spawnConfigCalls).toHaveLength(1);
    expect(spawnConfigCalls[0]?.session).toMatchObject({ captureEnv: true });
    expect(spawnConfigCalls[0]?.session?.historyFile).toMatch(
      new RegExp(`/${session.id}/shell-history$`),
    );
    f.ptys.write(session.id, term, 'echo probe-$CAPTURED_PROBE-hook-$PUDDLE_HOOK_MARKER\n');
    await waitFor(() => f.logs.readTail(session.id, term).includes('probe-shell-sees-me-hook-1'));
    await f.service.kill(session.id);
  });

  it('profile toggle off: env capture sleeps while cwd/history hooks remain armed', async () => {
    const spawnConfigCalls: Array<{ captureEnv: boolean; historyFile: string } | undefined> = [];
    const stubHooks = {
      spawnConfig: (_shell: string, session?: { captureEnv: boolean; historyFile: string }) => {
        spawnConfigCalls.push(session);
        return { args: [], env: {} };
      },
    } as unknown as import('../../src/pty/shell-hooks.js').ShellHooks;
    const f = fixture({ shellHooks: stubHooks });
    f.stores.profiles.patchSettings(f.ids.profile, { captureSessionEnv: false });
    const session = await liveSession(f);

    f.ptys.emit('env-delta', delta(session.id, 'MY_TOKEN', 'x'));
    expect(f.stores.sessions.getEnv(session.id)).toEqual({});

    f.stores.sessions.mergeEnv(session.id, { CAPTURED_PROBE: 'dormant' }, []);
    f.service.spawnShell(session.id);
    expect(spawnConfigCalls).toHaveLength(1);
    expect(spawnConfigCalls[0]).toMatchObject({ captureEnv: false });

    await f.service.kill(session.id);
    await f.service.resume(session.id);
    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('ENVPROBE<<'));
    expect(f.logs.readTail(session.id, 'agent')).toContain('ENVPROBE<<>>');
    // The stored map survives the off period.
    expect(f.stores.sessions.getEnv(session.id)).toEqual({ CAPTURED_PROBE: 'dormant' });
    await f.service.kill(session.id);
  });
});
