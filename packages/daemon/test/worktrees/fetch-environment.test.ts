import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/db/db.js';
import { RepoStore } from '../../src/db/stores/repos.js';
import { SessionStore } from '../../src/db/stores/sessions.js';
import type { GitOptions } from '../../src/git/exec.js';
import { KeyedMutex } from '../../src/git/mutex.js';
import { repoRoutes } from '../../src/http/routes/repos.js';
import { ensureHome, resolvePaths } from '../../src/paths.js';
import { WorktreeManager } from '../../src/worktrees/manager.js';
import { cloneRepo, initRepo } from '../helpers/git-fixtures.js';

/** The environment each `git fetch` received; git itself still runs for real. */
const fetches = vi.hoisted(() => [] as Array<NodeJS.ProcessEnv | undefined>);
vi.mock('../../src/git/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/git/exec.js')>();
  return {
    ...actual,
    git: (args: string[], opts?: GitOptions) => {
      if (args[0] === 'fetch') fetches.push(opts?.env);
      return actual.git(args, opts);
    },
  };
});

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
  fetches.splice(0);
});

/** A clone with an `origin`, registered with a manager that applies `platform`'s rules. */
function setup(platform: NodeJS.Platform) {
  const source = initRepo();
  const clone = cloneRepo(source);
  const home = mkdtempSync(join(tmpdir(), 'puddle-home-'));
  const paths = resolvePaths(home);
  ensureHome(paths);
  const db = openDatabase(paths.dbFile);
  cleanup.push(() => {
    db.close();
    for (const dir of [source, clone, home]) rmSync(dir, { recursive: true, force: true });
  });
  const repos = new RepoStore(db);
  const sessions = new SessionStore(db);
  const repo = repos.create({
    path: clone,
    default_base_branch: 'main',
    onboarding_notes: null,
    fetch_enabled: true,
  });
  const worktrees = new WorktreeManager({
    paths,
    mutex: new KeyedMutex(),
    repos,
    sessions,
    platform,
  });
  const app = new Hono().route('/api/repos', repoRoutes({ repos, sessions, worktrees }));
  return { repo, worktrees, app };
}

describe('fetch environments', () => {
  it('keeps unattended fetches quiet on Windows', async () => {
    const { repo, worktrees } = setup('win32');
    await worktrees.fetchRepo(repo);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      SSH_ASKPASS_REQUIRE: 'never',
    });
  });

  it('lets Settings’ "Fetch now" prompt through Git Credential Manager on Windows', async () => {
    const { repo, app } = setup('win32');
    const response = await app.request(`/api/repos/${repo.id}/fetch`, { method: 'POST' });
    expect(response.status).toBe(200);
    // The inherited environment, as for Source Control's fetch, pull and push.
    expect(fetches).toEqual([undefined]);
  });

  it('inherits the environment for every fetch on POSIX', async () => {
    const { repo, worktrees, app } = setup('linux');
    await worktrees.fetchRepo(repo);
    expect((await app.request(`/api/repos/${repo.id}/fetch`, { method: 'POST' })).status).toBe(200);
    expect(fetches).toEqual([undefined, undefined]);
  });
});
