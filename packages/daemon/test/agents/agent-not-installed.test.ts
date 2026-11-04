import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Account, AgentType, Profile, Project, Repo } from '@puddle/shared';
import { clearBinaryCache } from '../../src/agents/binary.js';
import { startDaemon, type RunningDaemon } from '../helpers/authorised-daemon.js';
import { fixture, fakeAdapter, nodeFakeAdapter } from '../helpers/daemon-fixtures.js';
import { initRepo } from '../helpers/git-fixtures.js';

const ABSENT = 'puddle-nonexistent-agent';

/**
 * An agent whose CLI is not installed must fail loudly and early (SPEC §5).
 * The regressions pinned here: node-pty does not throw for a missing
 * executable, so login used to open a terminal that died silently, and session
 * create used to report `account_logged_out` AND clear the logged-in flag.
 */
describe('uninstalled agent binary — HTTP surface', () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-noagent-home-'));
  const repoPath = initRepo();
  let daemon: RunningDaemon;
  let account: Account;
  let project: Project;

  function req(method: string, path: string, body?: unknown) {
    return fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${daemon.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await req(method, path, body);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  beforeAll(async () => {
    clearBinaryCache();
    daemon = await startDaemon({
      home,
      port: 0,
      adapters: [fakeAdapter({ binary: ABSENT })],
      version: 'no-agent',
      statusQuietMs: 150,
    });
    const profile = await json<Profile>('POST', '/api/profiles', {
      name: 'alice',
      branch_prefix: 'alice/',
    });
    account = await json<Account>('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'personal',
    });
    const repo = await json<Repo>('POST', '/api/repos', { path: repoPath });
    project = await json<Project>('POST', '/api/projects', {
      profile_id: profile.id,
      repo_id: repo.id,
      name: 'demo',
    });
  });

  afterAll(async () => {
    await daemon.stop().catch(() => undefined);
  });

  it('reports the agent as unavailable on GET /api/agents', async () => {
    const fake = (await json<AgentType[]>('GET', '/api/agents')).find((a) => a.id === 'fake');
    expect(fake?.binary).toBe(ABSENT);
    expect(fake?.available).toBe(false);
  });

  it('refuses to open a login PTY, with 424 agent_not_installed', async () => {
    const res = await req('POST', `/api/accounts/${account.id}/login`);
    expect(res.status).toBe(424);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('agent_not_installed');
    expect(body.error.message).toContain(ABSENT);
    // Rejected every time: no stream was cached on the first attempt either.
    expect((await req('POST', `/api/accounts/${account.id}/login`)).status).toBe(424);
  });

  it('rejects session creation with 424 rather than a misleading logged-out 409', async () => {
    const res = await req('POST', '/api/sessions', {
      project_id: project.id,
      account_id: account.id,
    });
    expect(res.status).toBe(424);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'agent_not_installed',
    );
  });
});

describe('uninstalled agent binary — the logged-in flag', () => {
  it('survives a rejected create instead of being cleared', async () => {
    clearBinaryCache();
    const f = fixture({ agentBinary: ABSENT });
    // A genuinely authenticated account: the flag is the daemon's to set.
    f.stores.accounts.setLoggedIn(f.ids.account, true);

    await expect(
      f.service.create({ project_id: f.ids.project, account_id: f.ids.account }),
    ).rejects.toMatchObject({ status: 424, code: 'agent_not_installed' });

    // The regression: checkLoggedIn answers "logged out" for an uninstalled
    // agent, so running it would have downgraded a perfectly good account.
    expect(f.stores.accounts.get(f.ids.account).logged_in).toBe(true);
    // And nothing was spawned.
    expect(f.stores.sessions.list().length).toBe(0);
  });

  it('still creates a session normally when the binary is present', async () => {
    clearBinaryCache();
    const f = fixture({ adapter: nodeFakeAdapter() });
    f.stores.accounts.setLoggedIn(f.ids.account, true);
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    expect(session.id).toBeTruthy();
    await f.service.kill(session.id).catch(() => undefined);
  });
});
