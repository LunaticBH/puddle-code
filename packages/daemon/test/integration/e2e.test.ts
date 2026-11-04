import WebSocket from 'ws';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, versionResponseSchema } from '@puddle/shared';
import type {
  Account,
  Profile,
  Project,
  Repo,
  RepoWithOrphans,
  Session,
  SessionEnvResponse,
  WsServerMessage,
} from '@puddle/shared';
import { stripAnsi } from '../../src/pty/ansi.js';
import { startDaemon, type RunningDaemon } from '../helpers/authorised-daemon.js';
import { fakeAdapter } from '../helpers/daemon-fixtures.js';
import { initRepo } from '../helpers/git-fixtures.js';
import { waitFor } from '../helpers/daemon-fixtures.js';

/** Thin authenticated fetch client against a live daemon. */
function client(daemon: RunningDaemon) {
  const base = `http://127.0.0.1:${daemon.port}`;
  return {
    async req(method: string, path: string, body?: unknown, token?: string) {
      const res = await fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${token ?? daemon.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return res;
    },
    async json<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await this.req(method, path, body);
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
      return (await res.json()) as T;
    },
  };
}

/** WS test client: authenticates, collects every server message. */
function wsClient(daemon: RunningDaemon) {
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
  const messages: WsServerMessage[] = [];
  ws.addEventListener('message', (evt) => {
    messages.push(JSON.parse(String(evt.data)) as WsServerMessage);
  });
  const open = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'auth', token: daemon.token, resource: daemon.resourceId() }));
      resolve();
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
  return {
    ws,
    messages,
    open,
    send(msg: unknown) {
      ws.send(JSON.stringify(msg));
    },
    outputFor(session: string, term = 'agent'): string {
      return messages
        .filter(
          (m) => (m.t === 'output' || m.t === 'replay') && m.session === session && m.term === term,
        )
        .map((m) => (m as { data: string }).data)
        .join('');
    },
    close() {
      ws.close();
    },
  };
}

// Shell tabs run the real shell: PowerShell on Windows, where Enter is CR. A
// wide terminal keeps deep temp paths from wrapping.
const windows = process.platform === 'win32';
const ENTER = windows ? '\r' : '\n';
const PRINT_DIRECTORY = windows ? '$PWD.ProviderPath\r' : 'pwd\n';

async function pollUntil(cond: () => Promise<boolean>, ms = 30000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('pollUntil timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('daemon end-to-end (Phase 1 acceptance)', () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-e2e-home-'));
  // Auto-resume defaults ON (config version 3); this suite exercises the
  // MANUAL interrupted → resume path, so pin it off (marker present, so the
  // migration respects the explicit false).
  writeFileSync(join(home, 'config.json'), JSON.stringify({ autoResume: false, configVersion: 3 }));
  const repoPath = initRepo();
  let daemon: RunningDaemon;
  const stops: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const stop of stops.reverse()) await stop().catch(() => undefined);
  });

  async function boot(): Promise<RunningDaemon> {
    const d = await startDaemon({
      home,
      port: 0,
      adapters: [fakeAdapter()],
      version: 'e2e',
      statusQuietMs: 150,
    });
    stops.push(() => d.stop());
    return d;
  }

  it('boots, rejects tokenless and wrong-token requests', async () => {
    daemon = await boot();
    const c = client(daemon);
    const anon = await fetch(`http://127.0.0.1:${daemon.port}/api/version`);
    expect(anon.status).toBe(401);
    const bad = await c.req('GET', '/api/version', undefined, 'f'.repeat(64));
    expect(bad.status).toBe(401);
    const ok = await c.req('GET', '/api/version');
    expect(ok.status).toBe(200);
    // The handshake payload: app version plus the protocol contract (SPEC §6).
    const version = versionResponseSchema.parse(await ok.json());
    expect(version.version).toBe('e2e');
    expect(version.protocol).toEqual(PROTOCOL_VERSION);
  });

  let profile: Profile;
  let alice1: Account;
  let alice2: Account;
  let repo: Repo;
  let project: Project;
  let s1: Session;
  let s2: Session;

  it('sets up profile → accounts → repo → project over REST', async () => {
    const c = client(daemon);
    profile = await c.json<Profile>('POST', '/api/profiles', {
      name: 'alice',
      branch_prefix: 'alice/',
    });
    alice1 = await c.json<Account>('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'personal',
    });
    alice2 = await c.json<Account>('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'org',
    });
    // Directories are keyed by profile id — the name is a display label only.
    expect(alice1.config_dir).toContain(
      join('profiles', profile.id, 'accounts', 'fake', 'personal'),
    );
    expect(alice2.config_dir).toContain(join('profiles', profile.id, 'accounts', 'fake', 'org'));
    // The fake adapter's "credentials": session spawns verify these exist.
    writeFileSync(join(alice1.config_dir, 'creds.json'), '{}');
    writeFileSync(join(alice2.config_dir, 'creds.json'), '{}');

    const badRepo = await c.req('POST', '/api/repos', { path: '/definitely/not/a/repo' });
    expect(badRepo.status).toBe(400);
    repo = await c.json<Repo>('POST', '/api/repos', {
      path: repoPath,
      onboarding_notes: 'always run make setup',
    });
    project = await c.json<Project>('POST', '/api/projects', {
      profile_id: profile.id,
      repo_id: repo.id,
      name: 'demo',
    });
    expect((await c.req('POST', `/api/projects/${project.id}/conversations/refresh`)).status).toBe(
      204,
    );
  });

  it('lists agent adapters and patches profile prefix and account opt-in', async () => {
    const c = client(daemon);
    const agents = await c.json<Array<{ id: string; capabilities: { skip_permissions: boolean } }>>(
      'GET',
      '/api/agents',
    );
    expect(agents.map((a) => a.id)).toEqual(['fake']);

    const host = await c.json<{ username: string; hostname: string; home: string }>(
      'GET',
      '/api/host',
    );
    expect(host.username.length).toBeGreaterThan(0);
    expect(host.hostname.length).toBeGreaterThan(0);
    expect(isAbsolute(host.home)).toBe(true);

    const renamedPrefix = await c.json<Profile>('PATCH', `/api/profiles/${profile.id}`, {
      branch_prefix: 'team/alice/',
    });
    expect(renamedPrefix.branch_prefix).toBe('team/alice/');
    await c.json<Profile>('PATCH', `/api/profiles/${profile.id}`, { branch_prefix: 'alice/' });

    const optedIn = await c.json<Account>('PATCH', `/api/accounts/${alice1.id}`, {
      skip_permissions_default: true,
    });
    expect(optedIn.skip_permissions_default).toBe(true);
    const optedOut = await c.json<Account>('PATCH', `/api/accounts/${alice1.id}`, {
      skip_permissions_default: false,
    });
    expect(optedOut.skip_permissions_default).toBe(false);
  });

  it('suggests directories (dotdirs included) with git detection', async () => {
    const c = client(daemon);
    const parent = join(repoPath, '..');
    // Near-unique prefix: the OS tmpdir holds many fixture dirs and the
    // endpoint caps its answer at 50 entries.
    const partial = basename(repoPath).slice(0, -1);
    const { entries } = await c.json<{
      entries: Array<{ path: string; name: string; is_git: boolean }>;
    }>('GET', `/api/fs/dirs?prefix=${encodeURIComponent(join(parent, partial))}`);
    const repoEntry = entries.find((e) => e.path === repoPath);
    expect(repoEntry?.is_git).toBe(true);

    // Dotdirs are listed too (the repo's .git itself, when completing inside it).
    const inside = await c.json<{ entries: Array<{ name: string }> }>(
      'GET',
      `/api/fs/dirs?prefix=${encodeURIComponent(join(repoPath, '.g'))}`,
    );
    expect(inside.entries.some((e) => e.name === '.git')).toBe(true);

    const relative = await c.req('GET', '/api/fs/dirs?prefix=not-absolute');
    expect(relative.status).toBe(400);

    // A leading ~ expands against the host home directory, and the trailing
    // slash survives expansion: `~/` lists HOME's contents — it must never
    // complete home's own basename inside its parent (the join() slash-drop
    // bug that made `~/…/` paths suggest nothing).
    const tilde = await c.json<{ entries: Array<{ path: string }> }>(
      'GET',
      '/api/fs/dirs?prefix=~/',
    );
    expect(tilde.entries.every((e) => e.path.startsWith(join(homedir(), '/')))).toBe(true);
    expect(tilde.entries.some((e) => e.path === homedir())).toBe(false);

    // Re-registering a known path (however spelt) returns the existing repo.
    const again = await c.json<Repo>('POST', '/api/repos', { path: repoPath });
    expect(again.id).toBe(repo.id);

    // Branch hints: local + fetched remote heads, default base first.
    const { branches } = await c.json<{
      branches: Array<{ name: string; is_session: boolean; session_title: string | null }>;
    }>('GET', `/api/repos/${repo.id}/branches`);
    expect(repo.default_base_branch).toBe('');
    expect(branches[0]?.name).toBe('main');

    // Project ids are 10-hex URL handles.
    expect(project.id).toMatch(/^[0-9a-f]{10}$/);
  });

  it('rejects skip_permissions against the closed gate with 400', async () => {
    const c = client(daemon);
    const res = await c.req('POST', '/api/sessions', {
      project_id: project.id,
      account_id: alice1.id,
      skip_permissions: true,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('skip_permissions_denied');
  });

  it('runs two sessions on two accounts with interleaved WS streaming', async () => {
    const c = client(daemon);
    s1 = await c.json<Session>('POST', '/api/sessions', {
      project_id: project.id,
      account_id: alice1.id,
      title: 'first task',
      prompt: 'do thing one',
    });
    s2 = await c.json<Session>('POST', '/api/sessions', {
      project_id: project.id,
      account_id: alice2.id,
      title: 'second task',
      prompt: 'do thing two',
    });
    expect(s1.branch).toBe('alice/first-task');
    expect(s2.branch).toBe('alice/second-task');

    const viewer = wsClient(daemon);
    await viewer.open;
    viewer.send({ t: 'subscribe-status' });
    viewer.send({ t: 'attach', session: s1.id, term: 'agent', cols: 100, rows: 30 });
    viewer.send({ t: 'attach', session: s2.id, term: 'agent', cols: 100, rows: 30 });

    await waitFor(
      () => viewer.outputFor(s1.id).includes('READY') && viewer.outputFor(s2.id).includes('READY'),
    );
    // Onboarding preamble reached both fresh worktrees, with each task prompt.
    expect(viewer.outputFor(s1.id)).toContain('freshly created git worktree');
    expect(viewer.outputFor(s1.id)).toContain('do thing one');
    expect(viewer.outputFor(s2.id)).toContain('do thing two');
    expect(viewer.outputFor(s2.id)).toContain('always run make setup');

    // stdin round-trips through the PTY (fake agent cats it back).
    viewer.send({ t: 'stdin', session: s1.id, term: 'agent', data: 'hello-agent-one\n' });
    await waitFor(() => viewer.outputFor(s1.id).includes('hello-agent-one'));

    // status broadcasts arrive for the subscriber.
    await waitFor(() => viewer.messages.some((m) => m.t === 'status' && m.session === s1.id));
    viewer.close();
  });

  it('serves the WS spawn-shell flow', async () => {
    const viewer = wsClient(daemon);
    await viewer.open;
    viewer.send({ t: 'spawn-shell', session: s1.id });
    await waitFor(() => viewer.messages.some((m) => m.t === 'shell-spawned'));
    const spawned = viewer.messages.find((m) => m.t === 'shell-spawned') as {
      session: string;
      term: string;
    };
    expect(spawned.term).toBe('shell-1');
    viewer.send({ t: 'attach', session: s1.id, term: spawned.term, cols: 400, rows: 24 });
    viewer.send({ t: 'stdin', session: s1.id, term: spawned.term, data: PRINT_DIRECTORY });
    await waitFor(() =>
      stripAnsi(viewer.outputFor(s1.id, spawned.term)).includes(s1.worktree_path),
    );
    viewer.close();
  });

  it('lets one viewer answer device queries: other viewers’ replies are stripped', async () => {
    const c = client(daemon);
    const s = await c.json<Session>('POST', '/api/sessions', {
      project_id: project.id,
      account_id: alice1.id,
      title: 'device replies',
      prompt: 'noop',
    });
    const a = wsClient(daemon);
    const b = wsClient(daemon);
    await a.open;
    await b.open;
    a.send({ t: 'attach', session: s.id, term: 'agent', cols: 100, rows: 30 });
    await waitFor(() => a.outputFor(s.id).includes('READY'));
    b.send({ t: 'attach', session: s.id, term: 'agent', cols: 100, rows: 30 });
    await waitFor(() => b.outputFor(s.id).includes('READY')); // replay seen ⇒ attach processed

    // B attached last, so B is the answering viewer: a reply-shaped sequence
    // in A's stdin is stripped (the duplicate a second emulator would add),
    // while the typing around it goes through untouched.
    a.send({ t: 'stdin', session: s.id, term: 'agent', data: 'first\x1b[12;34Rsecond\n' });
    await waitFor(() => a.outputFor(s.id).includes('firstsecond'));
    expect(a.outputFor(s.id)).not.toContain('12;34R');

    // ConPTY consumes a cursor report typed into its input as the console's own
    // answer, so a passed reply cannot be seen echoed there; the passing side
    // of the rule is covered by the gateway unit tests.
    if (!windows) {
      // The answering viewer's reply reaches the PTY.
      b.send({ t: 'stdin', session: s.id, term: 'agent', data: '\x1b[56;78R\n' });
      await waitFor(() => b.outputFor(s.id).includes('56;78R'));

      // B detaches — the role falls back to A, whose replies then pass. The
      // detach has no ack, so poll by re-sending until one lands.
      b.send({ t: 'detach', session: s.id, term: 'agent' });
      await waitFor(() => {
        a.send({ t: 'stdin', session: s.id, term: 'agent', data: '\x1b[99;9R\n' });
        return a.outputFor(s.id).includes('99;9R');
      });
    }

    a.close();
    b.close();
    await c.req('POST', `/api/sessions/${s.id}/kill`);
  });

  it('serves the home-stream shell: reused while live, ended by kill-shell', async () => {
    const viewer = wsClient(daemon);
    await viewer.open;
    const spawns = () =>
      viewer.messages.filter((m) => m.t === 'shell-spawned' && m.session === 'home') as Array<{
        term: string;
      }>;

    viewer.send({ t: 'spawn-shell', session: 'home' });
    await waitFor(() => spawns().length === 1);
    const term = spawns()[0]!.term;

    // A second spawn while the shell lives returns the SAME term — the
    // homescreen never stacks a second shell (SPEC §11).
    viewer.send({ t: 'spawn-shell', session: 'home' });
    await waitFor(() => spawns().length === 2);
    expect(spawns()[1]!.term).toBe(term);

    // The stream attaches like a session and the shell answers stdin. The
    // home shell is the user's own, unhooked: on Windows the line is left
    // unsubmitted, so it never reaches the user's PSReadLine history.
    viewer.send({ t: 'attach', session: 'home', term, cols: 80, rows: 24 });
    viewer.send({
      t: 'stdin',
      session: 'home',
      term,
      data: windows ? 'echo home-shell-ok' : `echo home-shell-ok${ENTER}`,
    });
    await waitFor(() => viewer.outputFor('home', term).includes('home-shell-ok'));

    // kill-shell ends it; attached viewers learn through `exit`.
    viewer.send({ t: 'kill-shell', session: 'home', term });
    await waitFor(() =>
      viewer.messages.some((m) => m.t === 'exit' && m.session === 'home' && m.term === term),
    );

    // With nothing live, the next spawn starts a FRESH shell (a new term, so
    // the dead shell's scrollback never replays into it).
    viewer.send({ t: 'spawn-shell', session: 'home' });
    await waitFor(() => spawns().length === 3);
    expect(spawns()[2]!.term).not.toBe(term);
    viewer.send({ t: 'kill-shell', session: 'home', term: spawns()[2]!.term });
    viewer.close();
  });

  it('syncs .puddle/onboarding-notes.md into the repo row', async () => {
    const c = client(daemon);
    writeFileSync(
      join(s1.worktree_path, '.puddle', 'onboarding-notes.md'),
      'always run make setup\nnever touch docker\n',
    );
    await pollUntil(async () => {
      const repos = await c.json<RepoWithOrphans[]>('GET', '/api/repos');
      return repos[0]?.onboarding_notes?.includes('docker') ?? false;
    });
  });

  it('broadcasts a user rename and an unrelated .puddle change never touches the title', async () => {
    const c = client(daemon);
    const viewer = wsClient(daemon);
    await viewer.open;
    viewer.send({ t: 'subscribe-status' });
    await new Promise((r) => setTimeout(r, 100)); // let the subscription register

    // A user renames via the UI (sets the title override).
    await c.json<Session>('PATCH', `/api/sessions/${s1.id}`, { title: 'kept by the user' });

    // The rename reaches every status-subscribed viewer live.
    await waitFor(() =>
      viewer.messages.some(
        (m) => m.t === 'renamed' && m.session === s1.id && m.title === 'kept by the user',
      ),
    );

    // An unrelated `.puddle` change (a notes edit) fires the same directory
    // watcher; the notes sync must not disturb the user's title.
    writeFileSync(
      join(s1.worktree_path, '.puddle', 'onboarding-notes.md'),
      'run pnpm install first\n',
    );
    await pollUntil(async () => {
      const repos = await c.json<RepoWithOrphans[]>('GET', '/api/repos');
      return repos[0]?.onboarding_notes?.includes('pnpm install') ?? false;
    });
    const session = await c.json<Session>('GET', `/api/sessions/${s1.id}`);
    expect(session.title).toBe('kept by the user');
    viewer.close();
  });

  it('restart marks sessions interrupted; resume restores; logs replay', async () => {
    await daemon.stop();
    daemon = await boot(); // reconcile pass runs here

    const c = client(daemon);
    const after1 = await c.json<Session>('GET', `/api/sessions/${s1.id}`);
    const after2 = await c.json<Session>('GET', `/api/sessions/${s2.id}`);
    expect(after1.status).toBe('interrupted');
    expect(after2.status).toBe('interrupted');

    const resumed = await c.json<Session>('POST', `/api/sessions/${s1.id}/resume`);
    expect(resumed.status).toBe('running');

    const viewer = wsClient(daemon);
    await viewer.open;
    viewer.send({ t: 'attach', session: s1.id, term: 'agent', cols: 100, rows: 30 });
    // Replay carries pre-restart output; live output shows the resume + note.
    await waitFor(() => viewer.outputFor(s1.id).includes('do thing one'));
    await waitFor(() => viewer.outputFor(s1.id).includes(`RESUME ref=fake-ref-${s1.id}`));
    await waitFor(() => viewer.outputFor(s1.id).includes('This session has been resumed'));
    viewer.close();

    await c.json<Session>('POST', `/api/sessions/${s1.id}/kill`);
  });

  it('archives a session (reversible hide), project archive sweeps the rest', async () => {
    const c = client(daemon);
    const archived = await c.json<Session>('POST', `/api/sessions/${s1.id}/archive`);
    expect(archived.status).toBe('archived');
    // Unarchive brings it straight back (worktree kept), then re-archive so the
    // project sweep below sees a clean slate.
    const unarchived = await c.json<Session>('POST', `/api/sessions/${s1.id}/unarchive`);
    expect(unarchived.status).toBe('exited');
    const res = await c.req('POST', `/api/projects/${project.id}/archive`, { force: true });
    expect(res.status).toBe(204);
    const all = await c.json<Session[]>('GET', `/api/sessions?project=${project.id}`);
    expect(all.every((s) => s.status === 'archived')).toBe(true);
  });

  it('stores ui state per profile; profiles never see each other’s workspaces', async () => {
    const c = client(daemon);
    const noState = await c.req('GET', `/api/profiles/${profile.id}/state`);
    expect(noState.status).toBe(404);
    expect(((await noState.json()) as { error: { code: string } }).error.code).toBe('no_state');

    const snapshotA = {
      session_tabs: [s1.id, s2.id],
      active_session: s1.id,
      editor_tabs: [],
      layout: { sidebar: 24 },
      explorer_pin: null,
      active_editor_tab: null,
      explorer_open: true,
      sidebar_mode: 'files',
      sidebar_collapsed: false,
      sessions_collapsed: false,
      session_order: [],
      layout_tree: null,
      project_layouts: {},
      layout_ref: null,
    };
    await c.json('PUT', `/api/profiles/${profile.id}/state`, { ui_state: snapshotA });

    // The profile reads its own row back — from any browser or tunnel port.
    const ownRow = await c.json<{ ui_state: typeof snapshotA }>(
      'GET',
      `/api/profiles/${profile.id}/state`,
    );
    expect(ownRow.ui_state).toEqual(snapshotA);

    // Another profile starts with a fresh workspace (no cross-profile seeding)
    // and its writes never clobber the first profile's row.
    const bob = await c.json<Profile>('POST', '/api/profiles', { name: 'bob' });
    const bobFresh = await c.req('GET', `/api/profiles/${bob.id}/state`);
    expect(bobFresh.status).toBe(404);
    await c.json('PUT', `/api/profiles/${bob.id}/state`, {
      ui_state: { ...snapshotA, active_session: s2.id },
    });
    const aliceAfter = await c.json<{ ui_state: { active_session: string } }>(
      'GET',
      `/api/profiles/${profile.id}/state`,
    );
    expect(aliceAfter.ui_state.active_session).toBe(s1.id);
    await c.req('DELETE', `/api/profiles/${bob.id}`); // keep the later delete test exact
  });

  it('login PTY flow marks the account logged in on clean exit', async () => {
    const c = client(daemon);
    const login = await c.json<{ stream: string; term: string }>(
      'POST',
      `/api/accounts/${alice1.id}/login`,
    );
    expect(login.stream).toBe(`login-${alice1.id}`);
    await pollUntil(async () => {
      const accounts = await c.json<Account[]>('GET', `/api/accounts?profile=${profile.id}`);
      return accounts.find((a) => a.id === alice1.id)?.logged_in ?? false;
    });
  });

  it('imports a pre-existing config dir by copy, leaving the source untouched', async () => {
    const c = client(daemon);
    const source = mkdtempSync(join(tmpdir(), 'puddle-import-'));
    writeFileSync(join(source, 'settings.json'), '{"theme":"dark"}\n');
    writeFileSync(join(source, 'creds.json'), 'opaque\n'); // fake adapter's logged-in marker

    const imported = await c.json<Account>('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'imported',
      import_dir: source,
    });
    // Copied into a puddle-owned dir, never linked in place…
    expect(imported.config_dir).toContain(
      join('profiles', profile.id, 'accounts', 'fake', 'imported'),
    );
    expect(existsSync(join(imported.config_dir, 'settings.json'))).toBe(true);
    // …with login state verified through the adapter, not assumed.
    expect(imported.logged_in).toBe(true);
    // The source survives, byte for byte where it was.
    expect(existsSync(join(source, 'settings.json'))).toBe(true);

    const bad = await c.req('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'imported-2',
      import_dir: '/definitely/not/a/dir',
    });
    expect(bad.status).toBe(400);
  });

  it('reports per-account usage: puddle counts plus agent token totals', async () => {
    const c = client(daemon);
    writeFileSync(
      join(alice1.config_dir, 'usage.json'),
      JSON.stringify({
        input_tokens: 1200,
        output_tokens: 340,
        cache_read_input_tokens: 90,
        cache_creation_input_tokens: 12,
        message_count: 7,
      }),
    );
    const usage = await c.json<{
      account_id: number;
      logged_in: boolean;
      session_count: number;
      agent_usage: { input_tokens: number; message_count: number } | null;
    }>('GET', `/api/accounts/${alice1.id}/usage`);
    expect(usage.account_id).toBe(alice1.id);
    expect(usage.logged_in).toBe(true);
    expect(usage.session_count).toBeGreaterThanOrEqual(1); // s1 ran on alice1
    expect(usage.agent_usage?.input_tokens).toBe(1200);
    expect(usage.agent_usage?.message_count).toBe(7);

    // No usage record → null token totals, counts still present.
    const bare = await c.json<{ agent_usage: unknown; session_count: number }>(
      'GET',
      `/api/accounts/${alice2.id}/usage`,
    );
    expect(bare.agent_usage).toBeNull();
  });

  it('degrades subscription usage to null when the adapter cannot provide it', async () => {
    const c = client(daemon);
    // The fake adapter has no subscriptionUsage hook, so the field stays
    // null — the endpoint degrades gracefully rather than erroring.
    const usage = await c.json<{ subscription: unknown }>(
      'GET',
      `/api/accounts/${alice1.id}/usage`,
    );
    expect(usage.subscription).toBeNull();
  });

  it('refuses to spawn on an account the agent says is logged out', async () => {
    const c = client(daemon);
    const loggedOut = await c.json<Account>('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'logged-out',
    });
    // No creds.json → the adapter's checkLoggedIn probe says no.
    const refused = await c.req('POST', '/api/sessions', {
      project_id: project.id,
      account_id: loggedOut.id,
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'account_logged_out',
    );
    // The stored flag is corrected to the verified truth.
    const accounts = await c.json<Account[]>('GET', `/api/accounts?profile=${profile.id}`);
    expect(accounts.find((a) => a.id === loggedOut.id)?.logged_in).toBe(false);
  });

  it('recovers a lost conversation ref by worktree on resume', async () => {
    const c = client(daemon);
    const s4 = await c.json<Session>('POST', '/api/sessions', {
      project_id: project.id,
      account_id: alice1.id,
      title: 'recovery test',
    });
    await c.json<Session>('POST', `/api/sessions/${s4.id}/kill`);

    // Simulate the agent having restarted the session under a fresh id: the
    // recorded ref's conversation is gone, a different one exists.
    rmSync(join(alice1.config_dir, `conv-fake-ref-${s4.id}`));
    writeFileSync(join(alice1.config_dir, 'discovered-ref'), 'fake-ref-recovered\n');

    const resumed = await c.json<Session>('POST', `/api/sessions/${s4.id}/resume`);
    expect(resumed.agent_session_ref).toBe('fake-ref-recovered');

    rmSync(join(alice1.config_dir, 'discovered-ref'));
    await c.json<Session>('POST', `/api/sessions/${s4.id}/kill`);
    await c.json<Session>('POST', `/api/sessions/${s4.id}/archive`, { force: true });
  });

  it('prunes a stopped session’s worktree, releasing the daemon’s own watcher in it', async () => {
    // The stopped session still watches <worktree>/.puddle for notes; Windows
    // refuses to remove a watched directory, so the prune must let go of it.
    const c = client(daemon);
    const s5 = await c.json<Session>('POST', '/api/sessions', {
      project_id: project.id,
      account_id: alice1.id,
      title: 'prune test',
      branch: 'alice/prune-test',
    });
    await pollUntil(
      async () => (await c.json<Session>('GET', `/api/sessions/${s5.id}`)).status !== 'starting',
    );
    await c.json<Session>('POST', `/api/sessions/${s5.id}/kill`);
    const pruned = await c.req(
      'DELETE',
      `/api/repos/${repo.id}/worktrees?path=${encodeURIComponent(s5.worktree_path)}`,
    );
    // Archived first, so a failure here leaves the later deletion tests intact.
    await c.json<Session>('POST', `/api/sessions/${s5.id}/archive`, { force: true });
    expect(pruned.status).toBe(200);
    expect(existsSync(s5.worktree_path)).toBe(false);
  });

  it('refuses deletion while sessions are live, then cascades account and profile', async () => {
    const c = client(daemon);
    // A fresh session (running) blocks both deletions with 409s.
    const s3 = await c.json<Session>('POST', '/api/sessions', {
      project_id: project.id,
      account_id: alice2.id,
      title: 'blocker',
    });
    const accountBlocked = await c.req('DELETE', `/api/accounts/${alice2.id}`);
    expect(accountBlocked.status).toBe(409);
    const profileBlocked = await c.req('DELETE', `/api/profiles/${profile.id}`);
    expect(profileBlocked.status).toBe(409);

    await c.json<Session>('POST', `/api/sessions/${s3.id}/kill`);
    await c.json<Session>('POST', `/api/sessions/${s3.id}/archive`, { force: true });

    // Account deletion removes its rows and its config dir on disk.
    const accountGone = await c.req('DELETE', `/api/accounts/${alice2.id}`);
    expect(accountGone.status).toBe(204);
    const remaining = await c.json<Account[]>('GET', `/api/accounts?profile=${profile.id}`);
    // alice1 plus the account created by the import test survive.
    expect(remaining.map((a) => a.id)).toContain(alice1.id);
    expect(remaining.map((a) => a.id)).not.toContain(alice2.id);
    expect(existsSync(alice2.config_dir)).toBe(false);
    expect(existsSync(alice1.config_dir)).toBe(true);

    // Profile deletion sweeps projects, remaining accounts, and the profile dir.
    const profileGone = await c.req('DELETE', `/api/profiles/${profile.id}`);
    expect(profileGone.status).toBe(204);
    expect(await c.json<unknown[]>('GET', '/api/profiles')).toEqual([]);
    expect(await c.json<unknown[]>('GET', '/api/projects')).toEqual([]);
    expect(existsSync(join(daemon.paths.profilesDir, 'alice'))).toBe(false);
  });
});

/**
 * Tier-2 reverse proxy end-to-end (Phase 5): a real dev-server-shaped listener
 * inside a session's process tree, reached over HTTP and via a raw WebSocket
 * upgrade through the daemon. The listener is a tiny node HTTP server that also
 * speaks minimal RFC 6455 (computes Sec-WebSocket-Accept, writes the 101, sends
 * one unmasked text frame), started from a `spawn-shell` terminal so it lands in
 * the session's process tree the port scanner walks — no Vite needed in CI.
 */
describe('tier-2 reverse proxy end-to-end (Phase 5 acceptance)', () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-e2e-proxy-'));
  const repoPath = initRepo();
  let daemon: RunningDaemon;
  let stopped = false;

  afterAll(async () => {
    if (!stopped) await daemon.stop().catch(() => undefined);
  });

  // The in-worktree listener, written to a file so the shell can `node` it
  // without shell-quoting a one-liner. Prints `PORT <n>` once listening.
  const LISTENER = [
    "const http=require('http'),crypto=require('crypto');",
    "let lastUpgradeUrl='none';",
    'const s=http.createServer((req,res)=>{',
    "  res.writeHead(200,{'content-type':'text/plain'});",
    "  if(req.url.startsWith('/seen-upgrade')){res.end(lastUpgradeUrl);return;}",
    "  if(req.url.startsWith('/seen-auth')){res.end(String(req.headers.authorization||'none'));return;}",
    "  res.end('proxy-ok');",
    '});',
    "s.on('upgrade',(req,sock)=>{",
    '  lastUpgradeUrl=req.url;',
    "  const key=req.headers['sec-websocket-key'];",
    "  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');",
    "  sock.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');",
    '  sock.write(Buffer.from([0x81,0x02,0x68,0x69]));', // unmasked text frame "hi"
    '});',
    "s.listen(0,'127.0.0.1',()=>console.log('PORT '+s.address().port));",
  ].join('\n');

  let sid: string;
  let listenerPort: number;

  it('boots, spawns a session listener, and detects its port', async () => {
    daemon = await startDaemon({
      home,
      port: 0,
      adapters: [fakeAdapter()],
      version: 'e2e-proxy',
      statusQuietMs: 150,
    });
    const c = client(daemon);
    const profile = await c.json<Profile>('POST', '/api/profiles', { name: 'proxy-user' });
    const account = await c.json<Account>('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'personal',
    });
    writeFileSync(join(account.config_dir, 'creds.json'), '{}');
    const repo = await c.json<Repo>('POST', '/api/repos', { path: repoPath });
    const project = await c.json<Project>('POST', '/api/projects', {
      profile_id: profile.id,
      repo_id: repo.id,
      name: 'proxy-demo',
    });
    const session = await c.json<Session>('POST', '/api/sessions', {
      project_id: project.id,
      account_id: account.id,
      title: 'proxy target',
    });
    sid = session.id;
    writeFileSync(join(session.worktree_path, 'listener.js'), LISTENER);

    // Run the listener from a real shell terminal so it joins the process tree.
    const viewer = wsClient(daemon);
    await viewer.open;
    viewer.send({ t: 'spawn-shell', session: sid });
    await waitFor(() => viewer.messages.some((m) => m.t === 'shell-spawned'));
    const shell = viewer.messages.find((m) => m.t === 'shell-spawned') as { term: string };
    viewer.send({ t: 'attach', session: sid, term: shell.term, cols: 400, rows: 24 });
    viewer.send({
      t: 'stdin',
      session: sid,
      term: shell.term,
      data: `node "${join(session.worktree_path, 'listener.js')}"${ENTER}`,
    });
    await waitFor(() => /PORT \d+/.test(viewer.outputFor(sid, shell.term)));
    listenerPort = Number(/PORT (\d+)/.exec(viewer.outputFor(sid, shell.term))![1]);
    viewer.close();

    // The scanner walks pidsFor + tree; the just-started port must surface.
    await pollUntilProxy(async () => {
      const { ports } = await c.json<{ ports: Array<{ port: number }> }>(
        'GET',
        `/api/sessions/${sid}/ports`,
      );
      return ports.some((p) => p.port === listenerPort);
    });
    expect(listenerPort).toBeGreaterThan(0);
  });

  it('rejects legacy query/cookie auth and forwards connection-authorised HTTP', async () => {
    const base = `http://127.0.0.1:${daemon.port}`;
    expect(
      (await fetch(`${base}/proxy/${sid}/${listenerPort}/?puddle_token=${daemon.token}`)).status,
    ).toBe(401);
    const forwarded = await fetch(`${base}/proxy/${sid}/${listenerPort}/`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(forwarded.status).toBe(200);
    expect(await forwarded.text()).toBe('proxy-ok');
  });

  it('never forwards the Authorization bearer to the upstream dev server', async () => {
    const base = `http://127.0.0.1:${daemon.port}`;
    // `Authorization: Bearer <daemon-token>` satisfies proxy auth, but the
    // full-RCE token must never reach a session's (agent-generated) dev server.
    const seen = await fetch(`${base}/proxy/${sid}/${listenerPort}/seen-auth`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(seen.status).toBe(200);
    expect(await seen.text()).toBe('none'); // the proxy stripped Authorization
  });

  it('proxies a raw WebSocket upgrade both directions', async () => {
    const url = `ws://127.0.0.1:${daemon.port}/proxy/${sid}/${listenerPort}/?puddle_token=${daemon.token}`;
    const ws = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${daemon.token}`,
        'x-puddle-resource': daemon.resourceId(),
      },
    });
    const first = await new Promise<string>((resolve, reject) => {
      ws.addEventListener('message', (evt) => resolve(String(evt.data)));
      ws.addEventListener('error', () => reject(new Error('proxied ws error')));
      setTimeout(() => reject(new Error('proxied ws timeout')), 15000);
    });
    expect(first).toBe('hi');
    ws.close();

    // The daemon token authed the handshake via ?puddle_token= — the upstream's
    // request line must NOT have seen it (it would land in dev-server logs).
    const seen = await fetch(
      `http://127.0.0.1:${daemon.port}/proxy/${sid}/${listenerPort}/seen-upgrade`,
      { headers: { authorization: `Bearer ${daemon.token}` } },
    );
    const seenUrl = await seen.text();
    expect(seenUrl).toBe('/'); // the sole query pair was spliced out
    expect(seenUrl).not.toContain('puddle_token');
  });

  it('stops cleanly while a proxied WebSocket is still open', async () => {
    const url = `ws://127.0.0.1:${daemon.port}/proxy/${sid}/${listenerPort}/?puddle_token=${daemon.token}`;
    const ws = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${daemon.token}`,
        'x-puddle-resource': daemon.resourceId(),
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('message', () => resolve());
      ws.addEventListener('error', () => reject(new Error('proxied ws error')));
      setTimeout(() => reject(new Error('proxied ws timeout')), 15000);
    });
    // With the upstream socket still live, stop() must not hang.
    await daemon.stop();
    stopped = true;
  });

  async function pollUntilProxy(cond: () => Promise<boolean>, ms = 10000): Promise<void> {
    const start = Date.now();
    while (!(await cond())) {
      if (Date.now() - start > ms) throw new Error('pollUntilProxy timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

/**
 * Tier-1 migration end-to-end (Workstream S, SPEC §5/§6). Uses the
 * share-capable `fakeAdapter({ share: true })` so a session's conversation is
 * adopted into the profile's shared store and reachable from every account —
 * migration is then "kill, repoint account_id, resume under the target's env"
 * with no file move. A second daemon on the plain (share-less) adapter covers
 * the `migration_unsupported` fall-through.
 */
describe('tier-1 migration end-to-end (Workstream S / SPEC §5)', () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-e2e-migrate-'));
  const repoPath = initRepo();
  let daemon: RunningDaemon;
  const stops: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const stop of stops.reverse()) await stop().catch(() => undefined);
  });

  let profile: Profile;
  let otherProfile: Profile;
  let accA: Account; // logged-in
  let accB: Account; // logged-in migration target
  let accC: Account; // logged-in, but on a DIFFERENT profile
  let accD: Account; // same profile, logged OUT
  let project: Project;

  /** Config dir marked logged-in for the share adapter (a creds.json marker). */
  async function loggedInAccount(c: ReturnType<typeof client>, label: string): Promise<Account> {
    const acc = await c.json<Account>('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label,
    });
    writeFileSync(join(acc.config_dir, 'creds.json'), '{}');
    return acc;
  }

  /** Canonical store dir holds the conversation once adoption has run. */
  function adopted(ref: string): boolean {
    const root = daemon.paths.profileSessionsDir(profile.id, 'fake');
    if (!existsSync(root)) return false;
    return readdirSync(root).some((k) => existsSync(join(root, k, `${ref}.jsonl`)));
  }

  /** Create a session on `accountId`, wait for adoption, and kill it. */
  async function killedSessionOn(
    c: ReturnType<typeof client>,
    accountId: number,
    extra: Record<string, unknown> = {},
  ): Promise<Session> {
    const s = await c.json<Session>('POST', '/api/sessions', {
      project_id: project.id,
      account_id: accountId,
      ...extra,
    });
    const viewer = wsClient(daemon);
    await viewer.open;
    viewer.send({ t: 'attach', session: s.id, term: 'agent', cols: 100, rows: 30 });
    await waitFor(() => viewer.outputFor(s.id).includes('READY'));
    viewer.close();
    await pollUntil(async () => adopted(`fake-ref-${s.id}`));
    await c.json<Session>('POST', `/api/sessions/${s.id}/kill`);
    return s;
  }

  it('sets up two logged-in accounts on one profile (plus a cross-profile and a logged-out one)', async () => {
    daemon = await startDaemon({
      home,
      port: 0,
      adapters: [fakeAdapter({ share: true })],
      version: 'e2e-migrate',
      statusQuietMs: 150,
    });
    stops.push(() => daemon.stop());
    const c = client(daemon);
    profile = await c.json<Profile>('POST', '/api/profiles', {
      name: 'mover',
      branch_prefix: 'm/',
    });
    accA = await loggedInAccount(c, 'account-a');
    accB = await loggedInAccount(c, 'account-b');
    accD = await c.json<Account>('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'logged-out',
    }); // no creds.json → the adapter reports it logged out

    otherProfile = await c.json<Profile>('POST', '/api/profiles', { name: 'other' });
    accC = await c.json<Account>('POST', '/api/accounts', {
      profile_id: otherProfile.id,
      agent_type: 'fake',
      label: 'elsewhere',
    });
    writeFileSync(join(accC.config_dir, 'creds.json'), '{}');

    const repo = await c.json<Repo>('POST', '/api/repos', { path: repoPath });
    project = await c.json<Project>('POST', '/api/projects', {
      profile_id: profile.id,
      repo_id: repo.id,
      name: 'migrate-demo',
    });
  });

  it('migrates a killed session to another account and resumes the SAME conversation', async () => {
    const c = client(daemon);
    const s = await killedSessionOn(c, accA.id);
    const ref = `fake-ref-${s.id}`;

    const migrated = await c.json<Session>('POST', `/api/sessions/${s.id}/migrate`, {
      account_id: accB.id,
    });
    expect(migrated.account_id).toBe(accB.id);
    expect(migrated.status).toBe('running'); // resumed under B

    // The fake agent, spawned under B's env, echoes its resume args: SAME ref,
    // and skip off (B never opted into the gate).
    const viewer = wsClient(daemon);
    await viewer.open;
    viewer.send({ t: 'attach', session: s.id, term: 'agent', cols: 100, rows: 30 });
    await waitFor(() => viewer.outputFor(s.id).includes(`RESUME ref=${ref} skip=false`));
    viewer.close();

    // The conversation never left the canonical store — B reads it through its
    // mirror symlink.
    expect(adopted(ref)).toBe(true);
    await c.json<Session>('POST', `/api/sessions/${s.id}/kill`);
  });

  it('rejects a cross-profile target, the current account, and a logged-out target', async () => {
    const c = client(daemon);
    const s = await killedSessionOn(c, accA.id);

    const cross = await c.req('POST', `/api/sessions/${s.id}/migrate`, { account_id: accC.id });
    expect(cross.status).toBe(400);
    expect(((await cross.json()) as { error: { code: string } }).error.code).toBe(
      'cross_profile_account',
    );

    const same = await c.req('POST', `/api/sessions/${s.id}/migrate`, { account_id: accA.id });
    expect(same.status).toBe(400);
    expect(((await same.json()) as { error: { code: string } }).error.code).toBe('same_account');

    const out = await c.req('POST', `/api/sessions/${s.id}/migrate`, { account_id: accD.id });
    expect(out.status).toBe(409);
    expect(((await out.json()) as { error: { code: string } }).error.code).toBe(
      'account_logged_out',
    );
  });

  it('re-evaluates the permission gate on migrate — a closed gate strips skip', async () => {
    const c = client(daemon);
    // Open the gate for BOTH accounts, then create a skip-permissions session.
    await c.json('PATCH', `/api/profiles/${profile.id}/settings`, { allowSkipPermissions: true });
    await c.json<Account>('PATCH', `/api/accounts/${accA.id}`, { skip_permissions_default: true });
    await c.json<Account>('PATCH', `/api/accounts/${accB.id}`, { skip_permissions_default: true });

    const s = await killedSessionOn(c, accA.id, { skip_permissions: true });

    // Close the gate before migrating: the resume under B must lose the flag.
    await c.json('PATCH', `/api/profiles/${profile.id}/settings`, { allowSkipPermissions: false });
    const migrated = await c.json<Session>('POST', `/api/sessions/${s.id}/migrate`, {
      account_id: accB.id,
    });
    expect(migrated.skip_permissions).toBe(false);

    const viewer = wsClient(daemon);
    await viewer.open;
    viewer.send({ t: 'attach', session: s.id, term: 'agent', cols: 100, rows: 30 });
    await waitFor(() => viewer.outputFor(s.id).includes(`RESUME ref=fake-ref-${s.id} skip=false`));
    // The downgrade is announced in the terminal (SPEC §11.4).
    await waitFor(() => viewer.outputFor(s.id).includes('skip-permissions no longer permitted'));
    expect(viewer.outputFor(s.id)).not.toContain(`RESUME ref=fake-ref-${s.id} skip=true`);
    viewer.close();
    await c.json<Session>('POST', `/api/sessions/${s.id}/kill`);
  });

  it('falls back to 409 migration_unsupported for a share-less agent', async () => {
    // A second daemon on the PLAIN fake adapter: no conversationShare, no
    // migrateSession → the conversation cannot follow the account.
    const home2 = mkdtempSync(join(tmpdir(), 'puddle-e2e-migrate-plain-'));
    const d2 = await startDaemon({
      home: home2,
      port: 0,
      adapters: [fakeAdapter()],
      version: 'e2e-migrate-plain',
      statusQuietMs: 150,
    });
    stops.push(() => d2.stop());
    const c = client(d2);
    const p = await c.json<Profile>('POST', '/api/profiles', { name: 'plain' });
    const mk = async (label: string) => {
      const a = await c.json<Account>('POST', '/api/accounts', {
        profile_id: p.id,
        agent_type: 'fake',
        label,
      });
      writeFileSync(join(a.config_dir, 'creds.json'), '{}');
      return a;
    };
    const a = await mk('a');
    const b = await mk('b');
    const repo = await c.json<Repo>('POST', '/api/repos', { path: initRepo() });
    const proj = await c.json<Project>('POST', '/api/projects', {
      profile_id: p.id,
      repo_id: repo.id,
      name: 'plain-demo',
    });
    const s = await c.json<Session>('POST', '/api/sessions', {
      project_id: proj.id,
      account_id: a.id,
    });
    await c.json<Session>('POST', `/api/sessions/${s.id}/kill`);

    const res = await c.req('POST', `/api/sessions/${s.id}/migrate`, { account_id: b.id });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'migration_unsupported',
    );
    // account_id stayed put — nothing moved.
    const after = await c.json<Session>('GET', `/api/sessions/${s.id}`);
    expect(after.account_id).toBe(a.id);
  });

  it('migrates a session that never reached waiting_input — migrate forces the adopt', async () => {
    // A dedicated daemon with a very long quiet window so the waiting_input
    // adoption never fires within the test: this reproduces a session that
    // exhausted credit on its FIRST turn, whose conversation is on disk but was
    // never adopted. Without the forced adopt in migrate, hasConversation(target)
    // is false and migrate wrongly 409s migration_unsupported.
    const home3 = mkdtempSync(join(tmpdir(), 'puddle-e2e-migrate-firstturn-'));
    const d3 = await startDaemon({
      home: home3,
      port: 0,
      adapters: [fakeAdapter({ share: true })],
      version: 'e2e-migrate-firstturn',
      statusQuietMs: 30000, // waiting_input (and its adopt) will not fire in-test
    });
    stops.push(() => d3.stop());
    const c = client(d3);
    const p = await c.json<Profile>('POST', '/api/profiles', { name: 'firstturn' });
    const mk = async (label: string): Promise<Account> => {
      const acc = await c.json<Account>('POST', '/api/accounts', {
        profile_id: p.id,
        agent_type: 'fake',
        label,
      });
      writeFileSync(join(acc.config_dir, 'creds.json'), '{}');
      return acc;
    };
    const a = await mk('a');
    const b = await mk('b');
    const repo = await c.json<Repo>('POST', '/api/repos', { path: initRepo() });
    const proj = await c.json<Project>('POST', '/api/projects', {
      profile_id: p.id,
      repo_id: repo.id,
      name: 'firstturn-demo',
    });
    const s = await c.json<Session>('POST', '/api/sessions', {
      project_id: proj.id,
      account_id: a.id,
    });
    const ref = `fake-ref-${s.id}`;

    const canonicalRoot = d3.paths.profileSessionsDir(p.id, 'fake');
    const isAdopted = (): boolean =>
      existsSync(canonicalRoot) &&
      readdirSync(canonicalRoot).some((k) => existsSync(join(canonicalRoot, k, `${ref}.jsonl`)));
    const perAccountConv = (): boolean => {
      const projects = join(a.config_dir, 'projects');
      return (
        existsSync(projects) &&
        readdirSync(projects).some((k) => existsSync(join(projects, k, `${ref}.jsonl`)))
      );
    };

    // The agent has written its per-account conversation JSONL, but adoption has
    // not run (create's early adopt fires before the file exists; waiting_input
    // is 30 s away) — the exact first-turn state migrate must handle.
    await pollUntil(async () => perAccountConv());
    expect(isAdopted()).toBe(false);
    await c.json<Session>('POST', `/api/sessions/${s.id}/kill`);
    expect(isAdopted()).toBe(false);

    const migrated = await c.json<Session>('POST', `/api/sessions/${s.id}/migrate`, {
      account_id: b.id,
    });
    expect(migrated.account_id).toBe(b.id);
    expect(migrated.status).toBe('running');
    expect(isAdopted()).toBe(true); // migrate forced the adopt, so B reads it
    await c.json<Session>('POST', `/api/sessions/${s.id}/kill`);
  });

  it('captured env: REST returns values; resume injects; clear stops it', async () => {
    const home4 = mkdtempSync(join(tmpdir(), 'puddle-e2e-env-'));
    const d4 = await startDaemon({
      home: home4,
      port: 0,
      adapters: [fakeAdapter()],
      version: 'e2e-env',
      statusQuietMs: 150,
    });
    stops.push(() => d4.stop());
    const c = client(d4);
    const p = await c.json<Profile>('POST', '/api/profiles', { name: 'envy' });
    const a = await c.json<Account>('POST', '/api/accounts', {
      profile_id: p.id,
      agent_type: 'fake',
      label: 'personal',
    });
    writeFileSync(join(a.config_dir, 'creds.json'), '{}');
    const repo4 = await c.json<Repo>('POST', '/api/repos', { path: initRepo() });
    const proj = await c.json<Project>('POST', '/api/projects', {
      profile_id: p.id,
      repo_id: repo4.id,
      name: 'env-demo',
    });
    const s = await c.json<Session>('POST', '/api/sessions', {
      project_id: proj.id,
      account_id: a.id,
    });

    // Empty to start; 404 for an unknown session.
    expect(await c.json<SessionEnvResponse>('GET', `/api/sessions/${s.id}/env`)).toEqual({
      vars: [],
    });
    const missing = await c.req('GET', '/api/sessions/00000000-0000-4000-8000-000000000000/env');
    expect(missing.status).toBe(404);

    // The fake agent PTY runs `cat`, which copies stdin bytes back verbatim —
    // sending the raw OSC 7733 sequence makes the PTY EMIT it, exactly like the
    // shell hook would from precmd.
    const viewer = wsClient(d4);
    await viewer.open;
    await pollUntil(async () => {
      const res = await c.req('GET', `/api/sessions/${s.id}`);
      return ((await res.json()) as Session).status !== 'starting';
    });
    viewer.send({ t: 'attach', session: s.id, term: 'agent', cols: 100, rows: 30 });
    if (windows) {
      // ConPTY parses escapes typed into its input instead of echoing them, so
      // a shell tab prints the report, as the PowerShell hook would. Node
      // decodes the \u escapes typed here.
      viewer.send({ t: 'spawn-shell', session: s.id });
      await waitFor(() => viewer.messages.some((m) => m.t === 'shell-spawned'));
      const shell = viewer.messages.find((m) => m.t === 'shell-spawned') as { term: string };
      viewer.send({
        t: 'stdin',
        session: s.id,
        term: shell.term,
        data:
          'node -e "process.stdout.write(\'\\u001b]7733;set;Q0FQVFVSRURfUFJPQkU=;' +
          'aHVudGVyMg==\\u0007\')"\r',
      });
    } else {
      viewer.send({
        t: 'stdin',
        session: s.id,
        term: 'agent',
        data: '\u001b]7733;set;Q0FQVFVSRURfUFJPQkU=;aHVudGVyMg==\u0007\n',
      });
    }
    await pollUntil(async () => {
      const env = await c.json<SessionEnvResponse>('GET', `/api/sessions/${s.id}/env`);
      return env.vars.length === 1;
    });
    // The authenticated cockpit receives the value so a name click can copy it.
    expect((await c.json<SessionEnvResponse>('GET', `/api/sessions/${s.id}/env`)).vars).toEqual([
      { name: 'CAPTURED_PROBE', value: 'hunter2', bytes: 7 },
    ]);
    // The decoded value never appears in the WS stream (the b64 does, once, as
    // the PTY's echo of what was typed — real hooks print, they don't type).
    expect(viewer.outputFor(s.id)).not.toContain('hunter2');

    // Resume injects: the fake adapter's resume script echoes ENVPROBE<<$CAPTURED_PROBE>>.
    await c.json<Session>('POST', `/api/sessions/${s.id}/kill`);
    await c.json<Session>('POST', `/api/sessions/${s.id}/resume`);
    await pollUntil(async () => {
      const res = await c.req('GET', `/api/sessions/${s.id}`);
      return ((await res.json()) as Session).status !== 'starting';
    });
    viewer.send({ t: 'attach', session: s.id, term: 'agent', cols: 100, rows: 30 });
    await pollUntil(async () =>
      Promise.resolve(viewer.outputFor(s.id).includes('ENVPROBE<<hunter2>>')),
    );

    // Clear: the map empties and the next resume injects nothing.
    const cleared = await c.json<{ cleared: number }>('DELETE', `/api/sessions/${s.id}/env`);
    expect(cleared).toEqual({ cleared: 1 });
    expect((await c.json<SessionEnvResponse>('GET', `/api/sessions/${s.id}/env`)).vars).toEqual([]);
    await c.json<Session>('POST', `/api/sessions/${s.id}/kill`);
    await c.json<Session>('POST', `/api/sessions/${s.id}/resume`);
    await pollUntil(async () => Promise.resolve(viewer.outputFor(s.id).includes('ENVPROBE<<>>')));
    viewer.close();
    await c.json<Session>('POST', `/api/sessions/${s.id}/kill`);
  });
});
