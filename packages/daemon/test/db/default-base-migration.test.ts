import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, onTestFinished } from 'vitest';
import { openDatabase } from '../../src/db/db.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import { ProfileStore } from '../../src/db/stores/profiles.js';
import { RepoStore } from '../../src/db/stores/repos.js';

function databaseFile() {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-base-migration-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'puddle.db');
}

it('clears every legacy repository default once while preserving settings and placements', () => {
  const file = databaseFile();
  let db = new Database(file);
  onTestFinished(() => db.close());
  for (const migration of MIGRATIONS.filter(({ version }) => version <= 22)) {
    db.exec(migration.sql);
    db.pragma(`user_version = ${migration.version}`);
  }
  db.pragma('foreign_keys = ON');
  const repos = new RepoStore(db);
  const profiles = new ProfileStore(db);
  const profile = profiles.create({ name: 'test', branch_prefix: 'test/' });
  for (const [index, base] of ['main', 'release/stable', ''].entries()) {
    const repo = repos.create({
      path: `/tmp/repo-${index}`,
      default_base_branch: base,
      onboarding_notes: index === 0 ? null : 'Run the setup script.',
      fetch_enabled: index !== 1,
    });
    repos.setLastFetchedAt(repo.id, '2026-09-01T00:00:00.000Z');
    // Seed the historical schema directly; current stores require new columns.
    const projectId = randomBytes(5).toString('hex');
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO projects (id, profile_id, repo_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(projectId, profile.id, repo.id, `project-${index}`, now, now);
    db.prepare(
      `INSERT INTO sessions
      (id, project_id, worktree_path, canonical_worktree_path, base_branch, branch,
       separate_branch, kind, title, status, skip_permissions, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'terminal', 'Existing placement', 'exited', 0, ?, ?)`,
    ).run(
      randomUUID(),
      projectId,
      `/tmp/worktree-${index}`,
      `/tmp/worktree-${index}`,
      base || 'develop',
      `test/topic-${index}`,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  }
  const oldRepos = repos.list();
  const oldProjects = db.prepare('SELECT * FROM projects ORDER BY id').all() as Record<
    string,
    unknown
  >[];
  const oldSessions = db.prepare('SELECT * FROM sessions ORDER BY id').all() as Record<
    string,
    unknown
  >[];
  db.close();

  db = openDatabase(file);
  expect(new RepoStore(db).list()).toEqual(
    oldRepos.map((repo) => ({ ...repo, default_base_branch: '' })),
  );
  expect(db.prepare('SELECT * FROM projects ORDER BY id').all()).toEqual(
    oldProjects.map((row) => ({ ...row, colour: null })),
  );
  expect(db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(
    oldSessions.map((row) => ({ ...row, agent_mode: 'interactive' })),
  );
  expect(() => db.prepare("UPDATE sessions SET agent_mode = 'unknown'").run()).toThrow(/CHECK/);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

  new RepoStore(db).patch(oldRepos[0]!.id, { default_base_branch: 'chosen/after-upgrade' });
  db.close();
  db = openDatabase(file);
  expect(new RepoStore(db).get(oldRepos[0]!.id).default_base_branch).toBe('chosen/after-upgrade');
  expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
});

it('uses an empty SQLite default for new repositories and retains path uniqueness', () => {
  const db = openDatabase(databaseFile());
  onTestFinished(() => db.close());
  const { lastInsertRowid } = db
    .prepare('INSERT INTO repos (path) VALUES (?)')
    .run('/tmp/new-repo');
  expect(new RepoStore(db).get(Number(lastInsertRowid))).toMatchObject({
    default_base_branch: '',
    fetch_enabled: true,
    onboarding_notes: null,
    last_fetched_at: null,
  });
  expect(() => db.prepare('INSERT INTO repos (path) VALUES (?)').run('/tmp/new-repo')).toThrow(
    /UNIQUE/,
  );
});
