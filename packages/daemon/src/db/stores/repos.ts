import type { Repo } from '@puddle/shared';
import { sameHostPath } from '../../host-path.js';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: number;
  path: string;
  default_base_branch: string;
  onboarding_notes: string | null;
  fetch_enabled: number;
  last_fetched_at: string | null;
}

function toRepo(r: Row): Repo {
  return {
    id: r.id,
    path: r.path,
    default_base_branch: r.default_base_branch,
    onboarding_notes: r.onboarding_notes,
    fetch_enabled: r.fetch_enabled === 1,
    last_fetched_at: r.last_fetched_at,
  };
}

export class RepoStore {
  constructor(private readonly db: Db) {}

  create(input: {
    path: string;
    default_base_branch: string;
    onboarding_notes: string | null;
    fetch_enabled: boolean;
  }): Repo {
    try {
      const info = this.db
        .prepare(
          `INSERT INTO repos (path, default_base_branch, onboarding_notes, fetch_enabled) VALUES (?, ?, ?, ?)`,
        )
        .run(
          input.path,
          input.default_base_branch,
          input.onboarding_notes,
          input.fetch_enabled ? 1 : 0,
        );
      return this.get(Number(info.lastInsertRowid));
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE')) {
        throw ApiError.conflict('repo_exists', `repo at '${input.path}' is already registered`);
      }
      throw e;
    }
  }

  list(): Repo[] {
    return (this.db.prepare(`SELECT * FROM repos ORDER BY id`).all() as Row[]).map(toRepo);
  }

  get(id: number): Repo {
    const row = this.db.prepare(`SELECT * FROM repos WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('repo', id);
    return toRepo(row);
  }

  /** Exact match; Windows then also matches another spelling of the same path. */
  getByPath(path: string, platform: NodeJS.Platform = process.platform): Repo | undefined {
    const row = this.db.prepare(`SELECT * FROM repos WHERE path = ?`).get(path) as Row | undefined;
    if (row) return toRepo(row);
    if (platform !== 'win32') return undefined;
    return this.list().find((repo) => sameHostPath(repo.path, path, platform));
  }

  patch(
    id: number,
    fields: Partial<Pick<Repo, 'default_base_branch' | 'onboarding_notes' | 'fetch_enabled'>>,
  ): Repo {
    const next = { ...this.get(id), ...fields };
    this.db
      .prepare(
        `UPDATE repos SET default_base_branch = ?, onboarding_notes = ?, fetch_enabled = ? WHERE id = ?`,
      )
      .run(next.default_base_branch, next.onboarding_notes, next.fetch_enabled ? 1 : 0, id);
    return this.get(id);
  }

  setLastFetchedAt(id: number, iso: string): void {
    this.db.prepare(`UPDATE repos SET last_fetched_at = ? WHERE id = ?`).run(iso, id);
  }

  setOnboardingNotes(id: number, notes: string): void {
    this.db.prepare(`UPDATE repos SET onboarding_notes = ? WHERE id = ?`).run(notes, id);
  }
}
