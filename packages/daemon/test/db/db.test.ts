import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/db.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import { AccountStore } from '../../src/db/stores/accounts.js';
import { EventStore } from '../../src/db/stores/events.js';
import { ProfileStore } from '../../src/db/stores/profiles.js';
import { ProjectStore } from '../../src/db/stores/projects.js';
import { RepoStore } from '../../src/db/stores/repos.js';
import { SessionStore } from '../../src/db/stores/sessions.js';
import { ConversationStore } from '../../src/db/stores/conversations.js';
import { CompilationSettingsStore } from '../../src/db/stores/compilation-settings.js';
import { ApiError } from '../../src/http/errors.js';

function freshDbFile() {
  return join(mkdtempSync(join(tmpdir(), 'puddle-db-')), 'puddle.db');
}

function stores(file = freshDbFile()) {
  const db = openDatabase(file);
  return {
    db,
    profiles: new ProfileStore(db),
    accounts: new AccountStore(db),
    repos: new RepoStore(db),
    projects: new ProjectStore(db),
    sessions: new SessionStore(db),
    conversations: new ConversationStore(db),
    events: new EventStore(db),
    compilationSettings: new CompilationSettingsStore(db),
  };
}

function seedSession(s: ReturnType<typeof stores>) {
  const profile = s.profiles.create({ name: 'alice', branch_prefix: 'alice/' });
  const account = s.accounts.create({
    profile_id: profile.id,
    agent_type: 'claude-code',
    label: 'personal',
    config_dir: '/tmp/cfg',
    skip_permissions_default: false,
  });
  const repo = s.repos.create({
    path: '/tmp/my-repo',
    default_base_branch: 'main',
    onboarding_notes: null,
    fetch_enabled: true,
  });
  const project = s.projects.create({ profile_id: profile.id, repo_id: repo.id, name: 'demo' });
  const session = s.sessions.create({
    id: 'a2f0c9d4-1111-4222-8333-444455556666',
    project_id: project.id,
    account_id: account.id,
    worktree_path: '/tmp/wt',
    base_branch: 'main',
    branch: 'alice/demo',
    kind: 'agent',
    agent_type: 'claude-code',
    title: 'demo',
    skip_permissions: false,
  });
  return { profile, account, repo, project, session };
}

describe('openDatabase', () => {
  it('migrates existing projects without choosing a colour and persists later choices', () => {
    const file = freshDbFile();
    const legacy = new Database(file);
    for (const migration of MIGRATIONS.filter((m) => m.version < 28)) {
      legacy.exec(migration.sql);
      legacy.pragma(`user_version = ${migration.version}`);
    }
    const profile = new ProfileStore(legacy).create({ name: 'work', branch_prefix: 'puddle/' });
    const repo = new RepoStore(legacy).create({
      path: '/tmp/project-colour-repo',
      default_base_branch: '',
      onboarding_notes: null,
      fetch_enabled: false,
    });
    const id = 'aabbccddee';
    legacy
      .prepare(
        `INSERT INTO projects (id, profile_id, repo_id, name, abbrev, created_at, updated_at)
       VALUES (?, ?, ?, 'existing', 'EXIST', ?, ?)`,
      )
      .run(id, profile.id, repo.id, new Date().toISOString(), new Date().toISOString());
    legacy.close();

    const migrated = openDatabase(file);
    const projects = new ProjectStore(migrated);
    expect(projects.get(id)).toMatchObject({ name: 'existing', abbrev: 'EXIST', colour: null });
    projects.update(id, { colour: 'cyan' });
    migrated.close();
    const reopened = openDatabase(file);
    expect(new ProjectStore(reopened).get(id).colour).toBe('cyan');
    reopened.close();
  });

  it('applies all migrations and records user_version', () => {
    const { db } = stores();
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    for (const t of [
      'profiles',
      'accounts',
      'repos',
      'projects',
      'profile_states',
      'sessions',
      'agent_conversations',
      'scratchpad',
      'events',
      'compilation_settings',
    ]) {
      expect(tables).toContain(t);
    }
    // The dormant prompts table was replaced by scratchpad in migration 014.
    expect(tables).not.toContain('prompts');
  });

  it('keys compilation commands by profile, project, provider, file and mode', () => {
    const s = stores();
    const { profile, project } = seedSession(s);
    const base = {
      profileId: profile.id,
      projectId: project.id,
      provider: 'latex',
      fileType: 'tex',
      filePath: '/outside folder/paper.tex',
    };
    s.compilationSettings.set(
      { ...base, mode: 'on_demand' },
      'latexmk -outdir={{output_dir}} {{source}}',
    );
    s.compilationSettings.set(
      { ...base, mode: 'eager' },
      'tectonic --outdir {{output_dir}} {{source}}',
    );
    expect(s.compilationSettings.get({ ...base, mode: 'on_demand' })).toContain('latexmk');
    expect(s.compilationSettings.get({ ...base, mode: 'eager' })).toContain('tectonic');
    s.compilationSettings.set({ ...base, mode: 'on_demand' }, null);
    expect(s.compilationSettings.get({ ...base, mode: 'on_demand' })).toBeNull();
    expect(s.compilationSettings.get({ ...base, mode: 'eager' })).toContain('tectonic');
  });

  it('is idempotent across reopen', () => {
    const file = freshDbFile();
    openDatabase(file).close();
    const db = openDatabase(file);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
  });

  it('migrates native conversations while preserving placements and aliases', () => {
    const file = freshDbFile();
    const v20 = new Database(file);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 20)) {
      v20.pragma('foreign_keys = OFF');
      v20.transaction(() => v20.exec(migration.sql))();
      v20.pragma(`user_version = ${migration.version}`);
    }
    v20.pragma('foreign_keys = ON');
    v20.exec(`
      INSERT INTO profiles (id, name, branch_prefix, created_at)
        VALUES ('aaaaaaaaaa', 'alice', 'alice/', '2026-01-01T00:00:00.000Z');
      INSERT INTO repos (id, path) VALUES (1, '/tmp/repo');
      INSERT INTO projects (id, profile_id, repo_id, name, created_at, updated_at) VALUES
        ('1111111111', 'aaaaaaaaaa', 1, 'one', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('2222222222', 'aaaaaaaaaa', 1, 'two', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO accounts
        (id, profile_id, agent_type, label, config_dir, created_at) VALUES
        (1, 'aaaaaaaaaa', 'claude-code', 'one', '/tmp/cfg-1', '2026-01-01T00:00:00.000Z'),
        (2, 'aaaaaaaaaa', 'claude-code', 'two', '/tmp/cfg-2', '2026-01-01T00:00:00.000Z'),
        (3, 'aaaaaaaaaa', 'claude-code', 'three', '/tmp/cfg-3', '2026-01-01T00:00:00.000Z');
      INSERT INTO sessions
        (id, project_id, account_id, worktree_path, base_branch, branch,
         separate_branch, kind, agent_type, agent_session_ref, title, agent_title,
         status, skip_permissions, session_env, created_at, updated_at) VALUES
        ('a2f0c9d4-1111-4222-8333-444455556666', '1111111111', 1, '/tmp/wt', 'main', 'alice/one',
         1, 'agent', 'claude-code', 'native-ref', 'user title', 'native title',
         'archived', 1, '{"KEPT":"yes"}', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('b2f0c9d4-1111-4222-8333-444455556666', '2222222222', 2, '/tmp/wt', 'main', 'alice/two',
         1, 'agent', 'claude-code', 'native-ref', NULL, 'native title',
         'exited', 0, '{}', '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
        ('c2f0c9d4-1111-4222-8333-444455556666', '1111111111', 3, '/tmp/wt', 'main', 'alice/one',
         1, 'agent', 'claude-code', 'native-ref', 'duplicate placement', 'native title',
         'exited', 0, '{}', '2026-01-06T00:00:00.000Z', '2026-01-06T00:00:00.000Z');
      INSERT INTO events (session_id, type, created_at)
        VALUES ('a2f0c9d4-1111-4222-8333-444455556666', 'kept', '2026-01-05T00:00:00.000Z');
    `);
    v20.close();

    const migrated = stores(file);
    const first = migrated.sessions.get('a2f0c9d4-1111-4222-8333-444455556666');
    const second = migrated.sessions.get('b2f0c9d4-1111-4222-8333-444455556666');
    const duplicate = migrated.sessions.get('c2f0c9d4-1111-4222-8333-444455556666');
    expect(first).toMatchObject({
      title: 'user title',
      agent_title: 'native title',
      agent_session_ref: 'native-ref',
      status: 'archived',
      skip_permissions: true,
    });
    expect(second.agent_session_ref).toBe('native-ref');
    expect(first.conversation_id).toBe(second.conversation_id);
    expect(duplicate.conversation_id).toBe(first.conversation_id);
    expect(migrated.sessions.aliasTarget(duplicate.id)).toBe(first.id);
    expect(first.branch_owner).toBe(true);
    expect(duplicate.branch_owner).toBe(false);
    expect(migrated.conversations.list()).toHaveLength(1);
    expect(migrated.sessions.getEnv(first.id)).toEqual({ KEPT: 'yes' });
    expect(migrated.events.list(first.id)).toHaveLength(1);
    expect(migrated.db.pragma('foreign_key_check')).toEqual([]);
  });

  it('enforces foreign keys', () => {
    const { db } = stores();
    expect(() =>
      db
        .prepare(
          `INSERT INTO accounts (profile_id, agent_type, label, config_dir, created_at)
           VALUES (999, 'claude-code', 'x', '/tmp/x', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('stores', () => {
  it('round-trips a profile with settings', () => {
    const s = stores();
    const p = s.profiles.create({ name: 'alice', branch_prefix: 'alice/' });
    expect(p.branch_prefix).toBe('alice/');
    expect(s.profiles.getSettings(p.id).allowSkipPermissions).toBe(false);
    const patched = s.profiles.patchSettings(p.id, { allowSkipPermissions: true });
    expect(patched.allowSkipPermissions).toBe(true);
    expect(s.profiles.getSettings(p.id).allowSkipPermissions).toBe(true);
  });

  it('sets and clears a profile icon and colour', () => {
    const s = stores();
    const p = s.profiles.create({ name: 'alice', branch_prefix: 'alice/' });
    expect(p.icon).toBeNull();
    expect(p.icon_colour).toBeNull();

    const set = s.profiles.setAppearance(p.id, { icon: 'rocket', icon_colour: 'blue' });
    expect(set).toMatchObject({ icon: 'rocket', icon_colour: 'blue' });
    // Surfaced by both get and list.
    expect(s.profiles.get(p.id).icon).toBe('rocket');
    expect(s.profiles.list().find((x) => x.id === p.id)?.icon_colour).toBe('blue');

    // A partial patch touches only the field sent…
    expect(s.profiles.setAppearance(p.id, { icon_colour: 'gold' })).toMatchObject({
      icon: 'rocket',
      icon_colour: 'gold',
    });
    // …and null clears it.
    expect(s.profiles.setAppearance(p.id, { icon: null }).icon).toBeNull();
  });

  it('rejects duplicate profile names with a 409', () => {
    const s = stores();
    s.profiles.create({ name: 'alice', branch_prefix: '' });
    try {
      s.profiles.create({ name: 'alice', branch_prefix: '' });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(409);
    }
  });

  it('renames a profile and rejects a clash with a 409', () => {
    const s = stores();
    const p = s.profiles.create({ name: 'alice', branch_prefix: 'alice/' });
    s.profiles.create({ name: 'bob', branch_prefix: 'bob/' });
    expect(s.profiles.setName(p.id, 'alice2').name).toBe('alice2');
    try {
      s.profiles.setName(p.id, 'bob'); // taken
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(409);
    }
  });

  it('throws 404 for a missing row', () => {
    const s = stores();
    try {
      s.profiles.get(42);
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(404);
    }
  });

  it('maps account booleans', () => {
    const s = stores();
    const { account } = seedSession(s);
    expect(account.logged_in).toBe(false);
    s.accounts.setLoggedIn(account.id, true);
    expect(s.accounts.get(account.id).logged_in).toBe(true);
  });

  it('notifies on a real logged-in change only (protocol 15.1)', () => {
    const s = stores();
    const { account } = seedSession(s);
    const seen: boolean[] = [];
    s.accounts.onLoggedInChanged = (a) => seen.push(a.logged_in);
    s.accounts.setLoggedIn(account.id, false); // already false — no event
    s.accounts.setLoggedIn(account.id, true);
    s.accounts.setLoggedIn(account.id, true); // no change — no event
    s.accounts.setLoggedIn(999, true); // no such account — no event, no throw
    expect(seen).toEqual([true]);
  });

  it('creates and transitions sessions', () => {
    const s = stores();
    const { session, repo } = seedSession(s);
    expect(session.status).toBe('starting');
    const running = s.sessions.setStatus(session.id, 'running');
    expect(running.status).toBe('running');
    expect(s.sessions.list({ status: 'running' })).toHaveLength(1);
    expect(s.sessions.listActiveByRepo(repo.id)).toHaveLength(1);
    s.sessions.setStatus(session.id, 'archived');
    expect(s.sessions.listActiveByRepo(repo.id)).toHaveLength(0);
  });

  it('merges, unsets, and clears captured session env', () => {
    const s = stores();
    const { session } = seedSession(s);
    expect(s.sessions.getEnv(session.id)).toEqual({});
    s.sessions.mergeEnv(session.id, { FOO: 'bar', TOKEN: 'a\nb "quoted" ✓' }, []);
    s.sessions.mergeEnv(session.id, { FOO: 'baz' }, []);
    expect(s.sessions.getEnv(session.id)).toEqual({ FOO: 'baz', TOKEN: 'a\nb "quoted" ✓' });
    // Unsetting a name the map doesn't own is a no-op.
    s.sessions.mergeEnv(session.id, {}, ['NOT_OWNED', 'FOO']);
    expect(s.sessions.getEnv(session.id)).toEqual({ TOKEN: 'a\nb "quoted" ✓' });
    expect(s.sessions.clearEnv(session.id)).toBe(1);
    expect(s.sessions.getEnv(session.id)).toEqual({});
    expect(() => s.sessions.getEnv('missing')).toThrow(ApiError);
  });

  it('never exposes session_env on Session objects', () => {
    const s = stores();
    const { session } = seedSession(s);
    s.sessions.mergeEnv(session.id, { SECRET: 'hunter2' }, []);
    for (const sess of [s.sessions.get(session.id), ...s.sessions.list()]) {
      expect(sess).not.toHaveProperty('session_env');
      expect(JSON.stringify(sess)).not.toContain('hunter2');
    }
  });

  it('degrades a corrupt session_env cell to an empty map', () => {
    const s = stores();
    const { session } = seedSession(s);
    s.db.prepare(`UPDATE sessions SET session_env = 'not json' WHERE id = ?`).run(session.id);
    expect(s.sessions.getEnv(session.id)).toEqual({});
    // A merge over a corrupt cell heals it.
    s.sessions.mergeEnv(session.id, { A: '1' }, []);
    expect(s.sessions.getEnv(session.id)).toEqual({ A: '1' });
  });

  it('patches repos and records fetch times', () => {
    const s = stores();
    const { repo } = seedSession(s);
    const patched = s.repos.patch(repo.id, { onboarding_notes: 'always pnpm install' });
    expect(patched.onboarding_notes).toBe('always pnpm install');
    s.repos.setLastFetchedAt(repo.id, '2026-07-13T00:00:00.000Z');
    expect(s.repos.get(repo.id).last_fetched_at).toBe('2026-07-13T00:00:00.000Z');
  });

  it('records events with JSON payloads', () => {
    const s = stores();
    const { session } = seedSession(s);
    s.events.record(session.id, 'created', { branch: 'alice/demo' });
    const events = s.events.list(session.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ branch: 'alice/demo' });
  });

  it('migrations remap integer project and profile ids to hex across every table', () => {
    // Build a version-1 database with data, exactly as Phase 1 wrote it.
    const file = freshDbFile();
    const v1 = new Database(file);
    v1.pragma('foreign_keys = ON');
    v1.exec(MIGRATIONS[0]!.sql);
    v1.pragma('user_version = 1');
    v1.exec(`
      INSERT INTO profiles (id, name, branch_prefix, created_at) VALUES (1, 'alice', 'alice/', 't');
      INSERT INTO repos (id, path) VALUES (1, '/tmp/repo');
      INSERT INTO projects (id, profile_id, repo_id, name, created_at, updated_at)
        VALUES (7, 1, 1, 'demo', 't', 't');
      INSERT INTO accounts (id, profile_id, agent_type, label, config_dir, created_at)
        VALUES (1, 1, 'fake', 'personal', '/tmp/home/profiles/alice/accounts/fake/personal', 't');
      INSERT INTO sessions (id, project_id, account_id, worktree_path, base_branch, branch,
                            agent_type, status, created_at, updated_at)
        VALUES ('11111111-1111-4111-8111-111111111111', 7, 1, '/tmp/wt', 'main', 'alice/x',
                'fake', 'archived', 't', 't');
      INSERT INTO project_states (project_id, client_id, ui_state, updated_at)
        VALUES (7, 'client-a', '{}', 't');
      INSERT INTO events (session_id, type, created_at)
        VALUES ('11111111-1111-4111-8111-111111111111', 'created', 't');
    `);
    v1.close();

    const db = openDatabase(file); // runs migrations 002 onwards
    const project = db.prepare(`SELECT * FROM projects`).get() as { id: string; name: string };
    expect(project.id).toMatch(/^[0-9a-f]{10}$/);
    expect(project.name).toBe('demo');
    const session = db.prepare(`SELECT project_id FROM sessions`).get() as { project_id: string };
    expect(session.project_id).toBe(project.id);
    // Migration 004 gives profiles hex ids and rewrites config-dir paths.
    const profile = db.prepare(`SELECT * FROM profiles`).get() as { id: string; name: string };
    expect(profile.id).toMatch(/^[0-9a-f]{10}$/);
    expect(profile.name).toBe('alice');
    const account = db.prepare(`SELECT profile_id, config_dir FROM accounts`).get() as {
      profile_id: string;
      config_dir: string;
    };
    expect(account.profile_id).toBe(profile.id);
    expect(account.config_dir).toBe(`/tmp/home/profiles/${profile.id}/accounts/fake/personal`);
    expect(db.prepare(`SELECT profile_id FROM projects`).get()).toEqual({
      profile_id: profile.id,
    });
    // Migration 003 re-keyed the layout row to the project's owning profile;
    // migration 013 re-keys it again to the profile alone.
    const state = db.prepare(`SELECT profile_id FROM profile_states`).get() as {
      profile_id: string;
    };
    expect(state.profile_id).toBe(profile.id);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM events`).get()).toEqual({ n: 1 });
    db.close();
  });
});
