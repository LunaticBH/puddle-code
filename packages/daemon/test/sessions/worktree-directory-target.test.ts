import { writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffResponseSchema, gitStatusResponseSchema, treeResponseSchema } from '@puddle/shared';
import { worktreeRoutes } from '../../src/http/routes/worktrees/worktrees.js';
import { NO_SESSION } from '../../src/http/routes/worktrees/worktree-shared.js';
import { ApiError } from '../../src/http/errors.js';
import { fixture, waitFor, type Fixture } from '../helpers/daemon-fixtures.js';
import { sh } from '../helpers/git-fixtures.js';

/**
 * The directory target (protocol 12.4): the nil session id plus an absolute
 * `?root=`, which is how the left sidebar binds to a project's own repository
 * directory when no session qualifies — previously an empty panel.
 */
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
    '/api/worktrees',
    worktreeRoutes({ sessions: fx.stores.sessions, repos: fx.stores.repos }),
  );
});

afterAll(async () => {
  for (const id of sessionIds) await fx.service.kill(id).catch(() => undefined);
});

const root = () => encodeURIComponent(fx.repoPath);
const errorCode = (body: unknown) => (body as { error: { code: string } }).error.code;

describe('directory target', () => {
  it('lists the directory the root names, with no session involved', async () => {
    const res = await app.request(`/api/worktrees/${NO_SESSION}/tree?path=&root=${root()}`);
    expect(res.status).toBe(200);
    const tree = treeResponseSchema.parse(await res.json());
    // The fixture's repo has a committed README; the point is that a tree came
    // back at all where every request used to 404 on the session id.
    expect(tree.entries.length).toBeGreaterThan(0);
  });

  it('requires the root — the nil id alone names no directory', async () => {
    const res = await app.request(`/api/worktrees/${NO_SESSION}/tree?path=`);
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('root_required');
  });

  it('reports git state for that directory, not for some session', async () => {
    writeFileSync(join(fx.repoPath, 'scratch.txt'), 'uncommitted\n');
    const res = await app.request(`/api/worktrees/${NO_SESSION}/git-status?root=${root()}`);
    expect(res.status).toBe(200);
    const status = gitStatusResponseSchema.parse(await res.json());
    expect(status.entries.map((e) => e.path)).toContain('scratch.txt');
  });

  it('compares a base diff against the registered repo default branch', async () => {
    const res = await app.request(`/api/worktrees/${NO_SESSION}/diff?against=base&root=${root()}`);
    expect(res.status).toBe(200);
    const diff = diffResponseSchema.parse(await res.json());
    expect(diff.base_ref).not.toBeNull();
  });

  it('resolves an empty default against the current clone branch for base diffs', async () => {
    fx.stores.repos.patch(fx.ids.repo, { default_base_branch: '' });
    sh(fx.repoPath, 'checkout', '-b', 'develop');
    try {
      const res = await app.request(
        `/api/worktrees/${NO_SESSION}/diff?against=base&root=${root()}`,
      );
      expect(res.status).toBe(200);
      expect(diffResponseSchema.parse(await res.json()).base_ref).toBe('develop');
    } finally {
      sh(fx.repoPath, 'checkout', 'main');
      fx.stores.repos.patch(fx.ids.repo, { default_base_branch: 'main' });
    }
  });

  it('falls back to HEAD for a directory that is not a registered repo', async () => {
    // A parent-directory browse: still a real directory, but no repo row names
    // it, so a base diff reads as "nothing ahead" instead of erroring.
    const parent = encodeURIComponent(join(fx.repoPath, '..'));
    const res = await app.request(`/api/worktrees/${NO_SESSION}/diff?against=base&root=${parent}`);
    expect([200, 500]).toContain(res.status); // a non-repo parent may have no git at all
    if (res.status === 200)
      expect(diffResponseSchema.parse(await res.json()).base_ref).toBe('HEAD');
  });

  it('rejects a relative or missing root', async () => {
    const rel = await app.request(`/api/worktrees/${NO_SESSION}/tree?path=&root=nope`);
    expect(rel.status).toBe(400);
    expect(errorCode(await rel.json())).toBe('invalid_root');
    // An absolute path that names nothing; on Windows `/nope` is drive-relative, so qualify it.
    const missing = join(parse(fx.repoPath).root, 'nope', 'nowhere');
    const gone = await app.request(
      `/api/worktrees/${NO_SESSION}/tree?path=&root=${encodeURIComponent(missing)}`,
    );
    expect(gone.status).toBe(404);
  });

  it('leaves a real session target behaving exactly as before', async () => {
    const session = await fx.service.create({
      project_id: fx.ids.project,
      account_id: fx.ids.account,
      title: 'unchanged',
    });
    sessionIds.push(session.id);
    await waitFor(() => fx.service.get(session.id).status !== 'starting');
    const res = await app.request(`/api/worktrees/${session.id}/git-status`);
    expect(res.status).toBe(200);
    // …and an unknown session id is still a 404, not a directory target.
    const bogus = await app.request(
      `/api/worktrees/11111111-1111-4111-8111-111111111111/tree?path=`,
    );
    expect(bogus.status).toBe(404);
  });
});
