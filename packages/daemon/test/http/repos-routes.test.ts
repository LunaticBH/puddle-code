import { rmSync } from 'node:fs';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoBranchesResponseSchema, repoSchema, type Repo } from '@puddle/shared';
import { repoRoutes } from '../../src/http/routes/repos.js';
import { fixture, type Fixture } from '../helpers/daemon-fixtures.js';
import { cloneRepo, initRepo, sh } from '../helpers/git-fixtures.js';

let fx: Fixture;
let app: Hono;
const cleanup: string[] = [];

beforeAll(() => {
  fx = fixture();
  app = new Hono();
  app.route(
    '/api/repos',
    repoRoutes({ repos: fx.stores.repos, sessions: fx.stores.sessions, worktrees: fx.worktrees }),
  );
});

afterAll(() => {
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
});

async function register(path: string, defaultBaseBranch?: string): Promise<Repo> {
  const response = await app.request('/api/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path,
      ...(defaultBaseBranch === undefined ? {} : { default_base_branch: defaultBaseBranch }),
    }),
  });
  expect(response.status).toBe(201);
  return repoSchema.parse(await response.json());
}

describe('POST /api/repos default base branch', () => {
  it('keeps an omitted default empty and follows later clone branch changes', async () => {
    const source = initRepo();
    sh(source, 'checkout', '-b', 'develop');
    const clone = cloneRepo(source);
    cleanup.push(source, clone);

    const repo = await register(clone);
    expect(repo.default_base_branch).toBe('');
    for (const branch of ['develop', 'topic']) {
      sh(clone, 'checkout', '-B', branch);
      const hints = await app.request(`/api/repos/${repo.id}/branches`);
      expect(hints.status).toBe(200);
      expect(repoBranchesResponseSchema.parse(await hints.json()).branches[0]?.name).toBe(branch);
      expect(fx.stores.repos.get(repo.id).default_base_branch).toBe('');
    }
  });

  it('honours an explicit base branch', async () => {
    const repo = initRepo();
    sh(repo, 'checkout', '-b', 'develop');
    cleanup.push(repo);

    expect((await register(repo, 'main')).default_base_branch).toBe('main');
  });

  it('preserves an explicitly empty default at registration', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    expect((await register(repo, '')).default_base_branch).toBe('');
  });

  it('clears a saved default and puts the current clone branch first in hints', async () => {
    const path = initRepo();
    cleanup.push(path);
    const repo = await register(path, 'main');
    const response = await app.request(`/api/repos/${repo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ default_base_branch: '' }),
    });
    expect(response.status).toBe(200);
    expect(repoSchema.parse(await response.json()).default_base_branch).toBe('');

    for (const branch of ['next', 'topic']) {
      sh(path, 'checkout', '-b', branch);
      const hints = await app.request(`/api/repos/${repo.id}/branches`);
      expect(hints.status).toBe(200);
      expect(repoBranchesResponseSchema.parse(await hints.json()).branches[0]?.name).toBe(branch);
      expect(fx.stores.repos.get(repo.id).default_base_branch).toBe('');
    }
  });

  it('keeps the default empty even when the clone is detached at registration', async () => {
    const repo = initRepo();
    sh(repo, 'checkout', '--detach');
    cleanup.push(repo);

    expect((await register(repo)).default_base_branch).toBe('');
  });
});
