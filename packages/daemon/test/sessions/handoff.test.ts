import { describe, expect, it } from 'vitest';
import { fixture, waitFor } from '../helpers/daemon-fixtures.js';

/**
 * Tier-2 cross-agent hand-off (SPEC §5): nothing moves. A new session is
 * created in the SAME worktree on a different agent, seeded with a briefing,
 * and the source session is left exactly as it was.
 */
describe('cross-agent hand-off', () => {
  async function withSession() {
    const f = fixture({ secondAgent: true });
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    // Let the fake agent emit output so there is a PTY log to fall back to.
    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('READY'), 10_000);
    return { f, session };
  }

  it('creates a new session in the same worktree and branch, leaving the source alone', async () => {
    const { f, session } = await withSession();
    const before = f.stores.sessions.get(session.id);

    const handed = await f.service.handoff(session.id, f.ids.account2!);

    expect(handed.id).not.toBe(session.id);
    expect(handed.worktree_path).toBe(session.worktree_path);
    expect(handed.branch).toBe(session.branch);
    expect(handed.agent_type).toBe('fake2');
    expect(handed.account_id).toBe(f.ids.account2);

    // The source is not killed or moved. Its exact status is the detector's
    // business — a live agent flips running ⇄ waiting_input on its own — so
    // assert it is still LIVE rather than pinning one value.
    const after = f.stores.sessions.get(session.id);
    expect(['starting', 'running', 'waiting_input']).toContain(after.status);
    expect(after.account_id).toBe(before.account_id);
    expect(f.ptys.has(session.id, 'agent')).toBe(true);

    await f.service.kill(session.id).catch(() => undefined);
    await f.service.kill(handed.id).catch(() => undefined);
  });

  it('links the two sessions with events on both sides', async () => {
    const { f, session } = await withSession();
    const handed = await f.service.handoff(session.id, f.ids.account2!);

    const out = f.stores.events.list(session.id).find((e) => e.type === 'handed_off_to');
    const back = f.stores.events.list(handed.id).find((e) => e.type === 'handed_off_from');
    expect(out).toBeDefined();
    expect(back).toBeDefined();
    expect(JSON.stringify(out?.payload)).toContain(handed.id);
    expect(JSON.stringify(back?.payload)).toContain(session.id);

    await f.service.kill(session.id).catch(() => undefined);
    await f.service.kill(handed.id).catch(() => undefined);
  });

  it('seeds the new session with a briefing carrying the git context', async () => {
    const { f, session } = await withSession();
    const handed = await f.service.handoff(session.id, f.ids.account2!);

    // The fake agent echoes its prompt as PROMPT<<...>>, so the briefing is
    // observable in the new session's own PTY log.
    await waitFor(() => f.logs.readTail(handed.id, 'agent').includes('PROMPT<<'), 10_000);
    const log = f.logs.readTail(handed.id, 'agent');
    expect(log).toContain('taking over a coding session');
    expect(log).toContain('Commits on this branch');
    expect(log).toContain('Working tree');

    await f.service.kill(session.id).catch(() => undefined);
    await f.service.kill(handed.id).catch(() => undefined);
  });

  it('falls back to the PTY log when the source adapter cannot export', async () => {
    // The primary 'fake' adapter has no exportTranscript, so this hand-off can
    // only have been seeded from the recorded terminal output.
    const { f, session } = await withSession();
    expect(f.adapters.get('fake').exportTranscript).toBeUndefined();
    const handed = await f.service.handoff(session.id, f.ids.account2!);

    await waitFor(() => f.logs.readTail(handed.id, 'agent').includes('PROMPT<<'), 10_000);
    // 'LAUNCH skip=' is a line the source agent printed to its terminal.
    expect(f.logs.readTail(handed.id, 'agent')).toContain('LAUNCH skip=');

    await f.service.kill(session.id).catch(() => undefined);
    await f.service.kill(handed.id).catch(() => undefined);
  });

  it('rejects a same-agent target — that is what migrate is for', async () => {
    const { f, session } = await withSession();
    await expect(f.service.handoff(session.id, f.ids.account)).rejects.toMatchObject({
      status: 400,
      code: 'same_agent',
    });
    await f.service.kill(session.id).catch(() => undefined);
  });

  it('rejects an archived source', async () => {
    const { f, session } = await withSession();
    await f.service.archive(session.id);
    await expect(f.service.handoff(session.id, f.ids.account2!)).rejects.toMatchObject({
      status: 409,
      code: 'session_archived',
    });
  });

  it('rejects a target account on another profile', async () => {
    const { f, session } = await withSession();
    const other = f.stores.profiles.create({ name: 'bob', branch_prefix: 'bob/' });
    const foreign = f.stores.accounts.create({
      profile_id: other.id,
      agent_type: 'fake2',
      label: 'personal',
      config_dir: f.paths.accountConfigDir(other.id, 'fake2', 'personal'),
      skip_permissions_default: false,
    });
    await expect(f.service.handoff(session.id, foreign.id)).rejects.toMatchObject({
      status: 400,
      code: 'cross_profile_account',
    });
    await f.service.kill(session.id).catch(() => undefined);
  });
});
