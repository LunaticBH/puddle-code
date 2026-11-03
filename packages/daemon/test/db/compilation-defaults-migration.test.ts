import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, onTestFinished } from 'vitest';
import { openDatabase } from '../../src/db/db.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import { CompilationSettingsStore } from '../../src/db/stores/compilation-settings.js';
import { ProfileStore } from '../../src/db/stores/profiles.js';

it('adds durable language defaults without changing legacy file commands', () => {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-compilation-migration-'));
  const file = join(directory, 'puddle.db');
  let db = new Database(file);
  onTestFinished(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const migration of MIGRATIONS.filter(({ version }) => version <= 26)) {
    db.exec(migration.sql);
    db.pragma(`user_version = ${migration.version}`);
  }
  const profile = new ProfileStore(db).create({ name: 'compile', branch_prefix: '' });
  // Seed the old schema independently of current project-store fields.
  const repo = db.prepare('INSERT INTO repos (path) VALUES (?)').run('/source').lastInsertRowid;
  db.prepare(
    'INSERT INTO projects (id, profile_id, repo_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    'bbbbbbbbbb',
    profile.id,
    repo,
    'paper',
    new Date().toISOString(),
    new Date().toISOString(),
  );
  const key = {
    profileId: profile.id,
    projectId: 'bbbbbbbbbb',
    provider: 'latex',
    fileType: 'tex',
    filePath: '/source/paper.tex',
    mode: 'on_demand' as const,
  };
  new CompilationSettingsStore(db).set(key, 'file-tex {{source}}');
  const legacy = db.prepare('SELECT * FROM compilation_settings').all();
  db.close();
  db = openDatabase(file);
  expect(db.prepare('SELECT * FROM compilation_settings').all()).toEqual(legacy);
  const settings = new CompilationSettingsStore(db);
  expect(settings.getDefault(profile.id, 'latex', 'on_demand')).toBeNull();
  settings.setDefault(profile.id, 'latex', 'on_demand', 'profile-tex {{source}}');
  db.close();
  db = openDatabase(file);
  expect(new CompilationSettingsStore(db).getDefault(profile.id, 'latex', 'on_demand')).toBe(
    'profile-tex {{source}}',
  );
  expect(new CompilationSettingsStore(db).get(key)).toBe('file-tex {{source}}');
  db.prepare('DELETE FROM projects WHERE id = ?').run(key.projectId);
  db.prepare('DELETE FROM profiles WHERE id = ?').run(profile.id);
  expect(db.prepare('SELECT * FROM compilation_defaults').all()).toEqual([]);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
