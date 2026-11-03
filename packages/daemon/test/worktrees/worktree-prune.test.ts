import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RepoWorktreesResponse } from '@puddle/shared';
import { repoRoutes } from '../../src/http/routes/repos.js';
import { ApiError } from '../../src/http/errors.js';
import { fixture, waitFor, type Fixture } from '../helpers/daemon-fixtures.js';
import { sh } from '../helpers/git-fixtures.js';

/** Worktree manager (SPEC §8): pruning worktrees + deleting orphaned branches. */

let fx: Fixture;
let app: Hono;
const sessionIds: string[] = [];

beforeAll(() => {
  fx = fixture();
  app = new Hono();
  app.onError((err, c) =>
    err instanceof ApiError
      ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
      : c.json({ error: { code: 'internal', message: String(err) } }, 500),
  );
  app.route(
    '/api/repos',
    repoRoutes({ repos: fx.stores.repos, sessions: fx.stores.sessions, worktrees: fx.worktrees }),
  );
});

afterAll(async () => {
  for (const id of sessionIds) await fx.service.kill(id).catch(() => undefined);
});

async function newSession(branch: string): Promise<{ id: string; worktree: string }> {
  const s = await fx.service.create({
    project_id: fx.ids.project,
    account_id: fx.ids.account,
    branch,
  });
  sessionIds.push(s.id);
  await waitFor(() => fx.service.get(s.id).status !== 'starting');
  return { id: s.id, worktree: s.worktree_path };
}

function list() {
  return app.request(`/api/repos/${fx.ids.repo}/worktrees`);
}
function prune(path: string) {
  const qs = new URLSearchParams({ path });
  return app.request(`/api/repos/${fx.ids.repo}/worktrees?${qs.toString()}`, { method: 'DELETE' });
}
function deleteBranch(name: string, confirm = false) {
  const qs = new URLSearchParams({ name });
  if (confirm) qs.set('confirm', '1');
  return app.request(`/api/repos/${fx.ids.repo}/branches?${qs.toString()}`, { method: 'DELETE' });
}
function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

describe('GET /api/repos/:id/worktrees', () => {
  it('lists the clone as the primary worktree with dirty/local_only status', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const body = (await res.json()) as RepoWorktreesResponse;
    const primary = body.worktrees.find((w) => w.is_primary);
    expect(primary?.path).toBe(fx.repoPath);
    expect(primary?.branch).toBe('main');
    // The fixture repo has no remote, so all its history is local-only.
    expect(primary?.local_only).toBe(true);
    expect(typeof primary?.dirty).toBe('boolean');
  });
});

describe('DELETE /api/repos/:id/worktrees (prune)', () => {
  it('refuses to prune the repository clone', async () => {
    const res = await prune(fx.repoPath);
    expect(res.status).toBe(409);
    expect(errorCode(await res.json())).toBe('worktree_primary');
  });

  it('404s an unknown path', async () => {
    const res = await prune('/no/such/worktree');
    expect(res.status).toBe(404);
  });

  it('refuses while a session is live, then prunes once it is not (branch kept, no confirm)', async () => {
    const { id, worktree } = await newSession('feat/live');
    // Fresh session is starting/running → live → blocked.
    const busy = await prune(worktree);
    expect(busy.status).toBe(409);
    expect(errorCode(await busy.json())).toBe('worktree_busy');

    await fx.service.kill(id); // now exited — not live
    // No confirm needed even though the branch is local-only: pruning keeps it.
    const ok = await prune(worktree);
    expect(ok.status).toBe(200);
    expect(existsSync(worktree)).toBe(false);
    const body = (await ok.json()) as RepoWorktreesResponse;
    expect(body.worktrees.some((w) => w.path === worktree)).toBe(false);
    // The branch survives the prune and is now an orphan (deletable).
    expect(body.orphan_branches.some((b) => b.name === 'feat/live')).toBe(true);
  });

  it('refuses to prune a dirty worktree', async () => {
    const { id, worktree } = await newSession('feat/dirty');
    await fx.service.kill(id);
    writeFileSync(join(worktree, 'README.md'), '# changed\n'); // modify a tracked file
    const res = await prune(worktree);
    expect(res.status).toBe(409);
    expect(errorCode(await res.json())).toBe('worktree_dirty');
  });
});

describe('DELETE /api/repos/:id/branches (delete orphaned branch)', () => {
  it('refuses to delete a branch that still has a worktree', async () => {
    const { id } = await newSession('feat/attached');
    const res = await deleteBranch('feat/attached', true);
    expect(res.status).toBe(409);
    expect(errorCode(await res.json())).toBe('branch_in_use');
    await fx.service.kill(id);
  });

  it('404s an unknown branch', async () => {
    const res = await deleteBranch('feat/does-not-exist', true);
    expect(res.status).toBe(404);
  });

  it('requires confirmation for an unpushed orphan, then deletes it', async () => {
    // Create a branch, then prune its worktree so the branch is orphaned.
    const { id, worktree } = await newSession('feat/gone');
    await fx.service.kill(id);
    expect((await prune(worktree)).status).toBe(200);

    // Orphaned + local-only (no remote in the fixture) → needs confirm.
    const noConfirm = await deleteBranch('feat/gone');
    expect(noConfirm.status).toBe(409);
    expect(errorCode(await noConfirm.json())).toBe('branch_unpushed');

    const confirmed = await deleteBranch('feat/gone', true);
    expect(confirmed.status).toBe(200);
    const body = (await confirmed.json()) as RepoWorktreesResponse;
    expect(body.orphan_branches.some((b) => b.name === 'feat/gone')).toBe(false);
    // The branch ref is really gone.
    expect(() => sh(fx.repoPath, 'rev-parse', '--verify', 'feat/gone')).toThrow();
  });
});
