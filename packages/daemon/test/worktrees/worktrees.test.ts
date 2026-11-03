import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/db.js';
import { RepoStore } from '../../src/db/stores/repos.js';
import { SessionStore } from '../../src/db/stores/sessions.js';
import { git, GitError } from '../../src/git/exec.js';
import { gitMutexKey, KeyedMutex } from '../../src/git/mutex.js';
import { ensureHome, resolvePaths } from '../../src/paths.js';
import { WorktreeManager } from '../../src/worktrees/manager.js';
import { slugify } from '../../src/worktrees/slug.js';
import { cloneRepo, commitFile, initRepo, sh } from '../helpers/git-fixtures.js';

function setup(repoPath: string) {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), 'puddle-home-')));
  ensureHome(paths);
  const db = openDatabase(paths.dbFile);
  const repos = new RepoStore(db);
  const sessions = new SessionStore(db);
  const repo = repos.create({
    path: repoPath,
    default_base_branch: 'main',
    onboarding_notes: null,
    fetch_enabled: true,
  });
  const manager = new WorktreeManager({ paths, mutex: new KeyedMutex(), repos, sessions });
  return { paths, repos, sessions, repo, manager };
}

describe('git exec', () => {
  it('returns trimmed stdout', async () => {
    expect(await git(['--version'])).toMatch(/^git version /);
  });

  it('throws GitError with stderr on failure', async () => {
    try {
      await git(['rev-parse', 'HEAD'], { cwd: tmpdir() });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GitError);
      expect((e as GitError).stderr.length).toBeGreaterThan(0);
    }
  });
});

describe('KeyedMutex', () => {
  it('serialises work per key and isolates keys', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const slow = mutex.run('a', async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push('a1');
    });
    const queued = mutex.run('a', async () => {
      order.push('a2');
    });
    const other = mutex.run('b', async () => {
      order.push('b1');
    });
    await Promise.all([slow, queued, other]);
    expect(order.indexOf('b1')).toBeLessThan(order.indexOf('a1'));
    expect(order.indexOf('a1')).toBeLessThan(order.indexOf('a2'));
  });

  it('keeps the queue alive after a rejection', async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.run('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await mutex.run('a', async () => 'still works')).toBe('still works');
  });

  it('gives linked worktrees the same canonical Git lock domain', async () => {
    const repo = initRepo();
    const linked = mkdtempSync(join(tmpdir(), 'puddle-linked-parent-'));
    const worktree = join(linked, 'worktree');
    sh(repo, 'worktree', 'add', '-b', 'linked-lock-test', worktree);
    expect(await gitMutexKey(worktree)).toBe(await gitMutexKey(repo));
  });
});

describe('slugify', () => {
  it('produces branch-safe slugs', () => {
    expect(slugify('Fix: teleop latency (v2)!')).toBe('fix-teleop-latency-v2');
    expect(slugify(null)).toBe('');
  });
});

describe('WorktreeManager.create', () => {
  it('branches from origin/<base> so a stale local base is never used', async () => {
    const origin = initRepo();
    const clone = cloneRepo(origin);
    const tip = commitFile(origin, 'new.txt', 'fresh'); // origin advances after the clone
    const { manager, repo, repos } = setup(clone);
    const result = await manager.create({
      repo,
      sessionId: randomUUID(),
      title: 'demo',
      branchPrefix: 'alice/',
    });
    expect(result.baseRef).toBe('origin/main');
    expect(sh(result.worktreePath, 'rev-parse', 'HEAD')).toBe(tip);
    expect(result.branch).toBe('alice/demo');
    expect(sh(result.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('alice/demo');
    expect(repos.get(repo.id).last_fetched_at).not.toBeNull();
  });

  it('falls back to the local base when there is no remote', async () => {
    const { manager, repo } = setup(initRepo());
    const result = await manager.create({
      repo,
      sessionId: randomUUID(),
      title: 'demo',
      branchPrefix: '',
    });
    expect(result.baseRef).toBe('main');
  });

  it('suffixes on branch-name collision instead of failing', async () => {
    const { manager, repo } = setup(initRepo());
    const a = await manager.create({
      repo,
      sessionId: randomUUID(),
      title: 'demo',
      branchPrefix: '',
    });
    const b = await manager.create({
      repo,
      sessionId: randomUUID(),
      title: 'demo',
      branchPrefix: '',
    });
    expect(a.branch).toBe('demo');
    expect(b.branch).toBe('demo-2');
  });

  it('falls back to a memorable triple name when there is no title or prompt', async () => {
    const { manager, repo } = setup(initRepo());
    const result = await manager.create({
      repo,
      sessionId: randomUUID(),
      branchPrefix: 'alice/',
    });
    expect(result.branch).toMatch(/^alice\/[a-z]+-[a-z]+-(earth|air|fire|water|metal|wood)$/);
  });

  it('rejects an unknown base branch', async () => {
    const { manager, repo } = setup(initRepo());
    await expect(
      manager.create({ repo, sessionId: randomUUID(), baseBranch: 'nope', branchPrefix: '' }),
    ).rejects.toMatchObject({ code: 'unknown_base' });
  });

  it('creates a git-excluded .puddle dir', async () => {
    const { manager, repo } = setup(initRepo());
    const { worktreePath } = await manager.create({
      repo,
      sessionId: randomUUID(),
      title: 'x',
      branchPrefix: '',
    });
    expect(existsSync(join(worktreePath, '.puddle'))).toBe(true);
    writeFileSync(join(worktreePath, '.puddle', 'onboarding-notes.md'), 'notes');
    expect(await manager.isClean(worktreePath)).toBe(true); // .puddle/ is excluded
  });
});

describe('WorktreeManager.remove', () => {
  it('refuses a dirty worktree without force, removes with force, keeps the branch', async () => {
    const repoPath = initRepo();
    const { manager, repo } = setup(repoPath);
    const { worktreePath } = await manager.create({
      repo,
      sessionId: randomUUID(),
      title: 'x',
      branchPrefix: '',
    });
    writeFileSync(join(worktreePath, 'dirty.txt'), 'uncommitted');
    await expect(manager.remove({ repo, worktreePath })).rejects.toMatchObject({
      code: 'worktree_dirty',
    });
    await manager.remove({ repo, worktreePath, force: true });
    expect(existsSync(worktreePath)).toBe(false);
    expect(sh(repoPath, 'branch', '--list', 'x')).toContain('x');
  });
});

describe('orphan detection', () => {
  it('flags worktree dirs with no session row', async () => {
    const { manager, repo, paths } = setup(initRepo());
    mkdirSync(join(paths.worktreesDir, String(repo.id), 'stray-dir'), { recursive: true });
    expect(manager.findOrphanWorktrees(repo)).toEqual([
      join(paths.worktreesDir, String(repo.id), 'stray-dir'),
    ]);
  });
});
