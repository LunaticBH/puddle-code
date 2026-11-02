import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { secret } from '@puddle/shared/node';
import { openDatabase } from '../src/db/db.js';
import { ProfileStore } from '../src/db/stores/profiles.js';
import { ProjectStore } from '../src/db/stores/projects.js';
import { SessionStore } from '../src/db/stores/sessions.js';
import { AccountStore } from '../src/db/stores/accounts.js';
import { RepoStore } from '../src/db/stores/repos.js';
import { LeaseRegistry } from '../src/security/leases.js';
import { bearerAuth } from '../src/security/middleware.js';
import { ProfileAccess, profileAccessMiddleware } from '../src/security/profile-access.js';
import { WsGateway, type WsGatewayDeps } from '../src/ws/gateway.js';
import { ApiError } from '../src/http/errors.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
function fixture() {
  const db = openDatabase(':memory:');
  cleanup.push(() => db.close());
  const stores = {
    profiles: new ProfileStore(db),
    projects: new ProjectStore(db),
    sessions: new SessionStore(db),
    accounts: new AccountStore(db),
    repos: new RepoStore(db),
  };
  const members = ['one', 'two'].map((name) => {
    const profile = stores.profiles.create({ name, branch_prefix: '' });
    const repo = stores.repos.create({
      path: `/tmp/profile-${name}`,
      default_base_branch: 'main',
      onboarding_notes: null,
      fetch_enabled: false,
    });
    const project = stores.projects.create({ name, profile_id: profile.id, repo_id: repo.id });
    const account = stores.accounts.create({
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'main',
      config_dir: `/tmp/config-${name}`,
      skip_permissions_default: false,
    });
    const session = stores.sessions.create({
      id: randomUUID(),
      project_id: project.id,
      account_id: null,
      worktree_path: repo.path,
      base_branch: 'main',
      branch: 'main',
      separate_branch: false,
      kind: 'terminal',
      agent_type: null,
      title: name,
      skip_permissions: false,
    });
    return { profile, project, repo, session, account };
  });
  const [one, two] = members;
  const authority = new LeaseRegistry();
  cleanup.push(() => authority.dispose());
  const access = new ProfileAccess(stores);
  const scoped = authority.create(one!.profile.id);
  const app = new Hono();
  app.onError((error, c) =>
    c.json({ error: 'denied' }, error instanceof ApiError ? (error.status as 403) : 500),
  );
  app.use('/api/*', bearerAuth(authority));
  app.use(
    '/api/*',
    profileAccessMiddleware({
      ...stores,
      service: { list: (filter) => stores.sessions.list(filter) },
    }),
  );
  const dispatch = vi.fn();
  app.all('*', (c) => {
    dispatch(c.req.path);
    return c.json({ ok: true });
  });
  const req = (path: string, method = 'GET', body?: object, token = scoped.token) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { ...stores, one: one!, two: two!, access, authority, req, dispatch };
}

describe('profile-bound host authority', () => {
  it('denies host-wide storage diagnostics to remote profile leases', async () => {
    const f = fixture();
    expect((await f.req('/api/storage')).status).toBe(403);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('denies notebook kernel operations to remote profile leases', async () => {
    const f = fixture();
    for (const [path, method] of [
      ['kernels', 'GET'],
      ['environments', 'POST'],
      ['status', 'POST'],
      ['kernel', 'POST'],
      ['execute', 'POST'],
      ['execution', 'POST'],
      ['input', 'POST'],
      ['intelligence', 'POST'],
      ['widgets', 'POST'],
      ['widgets/comm', 'POST'],
    ])
      expect((await f.req(`/api/notebooks/${path}`, method)).status).toBe(403);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('denies compilation defaults to remote profile leases', async () => {
    const f = fixture();
    for (const method of ['POST', 'PUT'])
      expect((await f.req('/api/compilation/defaults', method)).status).toBe(403);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('denies puddlang execution and inspection to remote profile leases', async () => {
    const f = fixture();
    for (const [path, method] of [
      [`/api/puddlang/${f.one.profile.id}/context`, 'GET'],
      [`/api/puddlang/${f.one.profile.id}/runs`, 'POST'],
      [`/api/puddlang/${f.one.profile.id}/runs/${randomUUID()}`, 'GET'],
    ])
      expect((await f.req(path!, method)).status).toBe(403);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('scopes discovery even when the browser omits filters, and leaves local leases unrestricted', async () => {
    const f = fixture();
    for (const [path, id] of [
      ['profiles', f.one.profile.id],
      ['projects', f.one.project.id],
      ['accounts', f.one.account.id],
      ['repos', f.one.repo.id],
      ['sessions', f.one.session.id],
    ]) {
      const response = await f.req(`/api/${path}`);
      expect(response.status).toBe(200);
      expect((await response.json()).map((row: { id: unknown }) => row.id)).toEqual([id]);
    }
    expect((await f.req(`/api/sessions?profile=${f.two.profile.id}`)).status).toBe(403);
    expect((await f.req(`/api/sessions?project=${f.two.project.id}`)).status).toBe(403);
    expect((await f.req(`/api/profiles/${f.two.profile.id}/settings`)).status).toBe(403);
    const local = f.authority.create();
    expect(
      (await f.req(`/api/sessions/${f.two.session.id}`, 'GET', undefined, local.token)).status,
    ).toBe(200);
  });

  it('rejects cross-profile reads, writes and neighbouring operations before dispatch', async () => {
    const f = fixture();
    for (const method of ['GET', 'PATCH'])
      expect((await f.req(`/api/sessions/${f.two.session.id}`, method)).status).toBe(403);
    for (const operation of ['kill', 'resume', 'archive', 'unarchive'])
      expect((await f.req(`/api/sessions/${f.two.session.id}/${operation}`, 'POST')).status).toBe(
        403,
      );
    for (const operation of ['file', 'preview-asset', 'git-status', 'diff'])
      expect((await f.req(`/api/worktrees/${f.two.session.id}/${operation}`)).status).toBe(403);
    expect((await f.req(`/api/projects/${f.two.project.id}`)).status).toBe(403);
    expect((await f.req(`/api/repos/${f.two.repo.id}/branches`)).status).toBe(403);
    expect((await f.req('/api/config', 'PATCH', {})).status).toBe(403);
    expect(
      (await f.req('/api/sessions', 'POST', { project_id: f.two.project.id, kind: 'terminal' }))
        .status,
    ).toBe(403);
    expect(
      (
        await f.req('/api/sessions', 'POST', {
          project_id: f.one.project.id,
          account_id: f.two.account.id,
        })
      ).status,
    ).toBe(403);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect((await f.req(`/api/sessions/${f.one.session.id}/resume`, 'POST')).status).toBe(200);
    expect(
      (await f.req('/api/sessions', 'POST', { project_id: f.one.project.id, kind: 'terminal' }))
        .status,
    ).toBe(200);
  });

  it('filters status, notices, account updates, catalogue events and placement switches', () => {
    const f = fixture();
    const own = f.one.session.id;
    const foreign = f.two.session.id;
    for (const session of [own, foreign]) {
      const event = {
        t: 'notice' as const,
        session,
        title: 'private name',
        level: 'error' as const,
      };
      expect(f.access.event(f.one.profile.id, event)).toEqual(session === own ? event : null);
    }
    expect(
      f.access.event(f.one.profile.id, {
        t: 'sessions-changed',
        project_ids: [f.one.project.id, f.two.project.id],
      }),
    ).toEqual({ t: 'sessions-changed', project_ids: [f.one.project.id] });
    expect(
      f.access.event(f.one.profile.id, {
        t: 'account',
        profile_id: f.two.profile.id,
        account_id: f.two.account.id,
        logged_in: true,
      }),
    ).toBeNull();
    expect(
      f.access.event(f.one.profile.id, {
        t: 'session-switched',
        source_session: own,
        target_session: foreign,
        target_project: f.two.project.id,
        cause: 'resume',
        outcome: 'rebound',
      }),
    ).toBeNull();
  });

  it('rejects foreign terminal input without requiring an attach, and filters real gateway events', async () => {
    const f = fixture();
    const ptys = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      resize: vi.fn(),
      snapshot: vi.fn(async () => 'screen'),
      kill: vi.fn(),
    });
    const service = Object.assign(new EventEmitter(), {
      get: (id: string) => f.sessions.get(id),
      spawnShell: vi.fn(() => 'shell-1'),
    });
    // Minimal PTY/service doubles: this test exercises the real gateway and scope checks.
    const gateway = new WsGateway({
      authority: f.authority,
      profileAccess: f.access,
      ptys,
      service,
      theme: { set: vi.fn() },
    } as unknown as WsGatewayDeps);
    const send = vi.fn();
    const ws = { readyState: 1, send, close: vi.fn() } as unknown as WSContext;
    const connection = gateway.connection();
    const receive = (message: object) =>
      connection.onMessage({ data: JSON.stringify(message) }, ws);
    receive({ t: 'auth', token: f.authority.create(f.one.profile.id).token, resource: secret() });
    receive({ t: 'subscribe-status' });
    for (const session of [f.two.session.id, 'home', `login-${f.two.account.id}`]) {
      receive({ t: 'stdin', session, term: 'agent', data: 'secret' });
      receive({ t: 'attach', session, term: 'agent', cols: 80, rows: 24 });
      receive({ t: 'spawn-shell', session });
    }
    expect(ptys.write).not.toHaveBeenCalled();
    expect(ptys.snapshot).not.toHaveBeenCalled();
    expect(service.spawnShell).not.toHaveBeenCalled();
    send.mockClear();
    service.emit('status', {
      session: f.two.session.id,
      status: 'running',
      last_activity_at: null,
    });
    expect(send).not.toHaveBeenCalled();
    receive({ t: 'stdin', session: f.one.session.id, term: 'agent', data: 'own' });
    expect(ptys.write).toHaveBeenCalledWith(f.one.session.id, 'agent', 'own');
    service.emit('status', {
      session: f.one.session.id,
      status: 'running',
      last_activity_at: null,
    });
    expect(send).toHaveBeenCalledOnce();
    connection.onClose({}, ws);
  });
});

it('keeps connector-only notification operations outside daemon profile authority', async () => {
  const f = fixture();
  expect((await f.req('/api/notifications/push', 'POST', { subscription: null })).status).toBe(403);
  expect((await f.req('/api/notifications/test', 'POST')).status).toBe(403);
  expect(f.dispatch).not.toHaveBeenCalled();
});
