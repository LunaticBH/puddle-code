import type { StorageMonitor } from '../storage/monitor.js';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { normaliseHostPath, type Repo, type WorktreeInfo } from '@puddle/shared';
import type { RepoStore } from '../db/stores/repos.js';
import type { SessionStore } from '../db/stores/sessions.js';
import { backgroundGitEnv, git } from '../git/exec.js';
import { resolveDefaultBaseBranch } from '../git/base-branch.js';
import { gitMutexKey, type KeyedMutex } from '../git/mutex.js';
import { canonicalHostPath } from '../host-path.js';
import { ApiError } from '../http/errors.js';
import type { PuddlePaths } from '../paths.js';
import { memorableName } from './names.js';
import { promptSlug, slugify } from './slug.js';
import { assertNotHeldOpen, worktreeBusy } from './windows-removal.js';

export interface CreateWorktreeResult {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseRef: string;
  /** False when an existing shared worktree was attached rather than created. */
  created: boolean;
}

export class WorktreeManager {
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly deps: {
      paths: PuddlePaths;
      storage?: StorageMonitor;
      mutex: KeyedMutex;
      repos: RepoStore;
      sessions: SessionStore;
      /** Path and removal rules; the host's own by default. */
      platform?: NodeJS.Platform;
    },
  ) {
    this.platform = deps.platform ?? process.platform;
  }

  /** Share the manager's canonical common-dir lock with source-control routes. */
  async runGitMutation<T>(repoRoot: string, run: () => Promise<T>): Promise<T> {
    return this.deps.mutex.run(await gitMutexKey(repoRoot), run);
  }

  /**
   * All repo-mutating work runs under the repo mutex. The fetch inside create
   * calls the unmutexed core directly — KeyedMutex is not reentrant.
   */
  create(opts: {
    repo: Repo;
    sessionId: string;
    baseBranch?: string;
    requestedBranch?: string;
    title?: string | null;
    prompt?: string | null;
    branchPrefix: string;
  }): Promise<CreateWorktreeResult> {
    const { repo } = opts;
    return this.runGitMutation(repo.path, async () => {
      await this.deps.storage?.assertAdmission([
        this.deps.paths.home,
        this.deps.paths.worktreesDir,
        repo.path,
      ]);
      const baseBranch = opts.baseBranch ?? (await resolveDefaultBaseBranch(repo));
      await this.fetchCoreQuietly(repo);
      const baseRef = (await this.refExists(repo, `refs/remotes/origin/${baseBranch}`))
        ? `origin/${baseBranch}`
        : baseBranch;
      if (baseRef === baseBranch && !(await this.refExists(repo, `refs/heads/${baseBranch}`))) {
        throw ApiError.badRequest('unknown_base', `base branch '${baseBranch}' does not exist`);
      }
      const branch = await this.pickBranchName(repo, opts);
      const worktreePath = this.deps.paths.sessionWorktreeDir(repo.id, opts.sessionId);
      mkdirSync(dirname(worktreePath), { recursive: true });
      await git(['worktree', 'add', worktreePath, '-b', branch, baseRef], { cwd: repo.path });
      await this.excludePuddleDir(repo);
      mkdirSync(join(worktreePath, '.puddle'), { recursive: true });
      return { worktreePath, branch, baseBranch, baseRef, created: true };
    });
  }

  /**
   * The separate_branch = false, separate_worktree = false path (SPEC §4): the
   * base branch's default shared directory. **If that branch is the one checked
   * out in the repo's own clone, that clone IS the directory** — puddle stays
   * faithful to where the user cloned the repo rather than making a second
   * checkout beside it. Otherwise one shared worktree per (repo, branch) at
   * `worktrees/<repo_id>/branch-<slug>/`; the first such session creates it,
   * later ones attach.
   */
  attachShared(opts: { repo: Repo; baseBranch?: string }): Promise<CreateWorktreeResult> {
    const { repo } = opts;
    return this.runGitMutation(repo.path, async () => {
      await this.deps.storage?.assertAdmission([
        this.deps.paths.home,
        this.deps.paths.worktreesDir,
        repo.path,
      ]);
      const branch = opts.baseBranch ?? (await resolveDefaultBaseBranch(repo));
      await this.fetchCoreQuietly(repo);

      // The clone itself, when it is on this branch: land there, not a sibling.
      // Its branch may be unborn (no commits/ref yet). Sharing the existing
      // directory needs no commit, so resolve it before requiring a base ref.
      const primary = (await this.listWorktrees(repo)).find((w) => w.is_primary);
      if (primary && primary.branch === branch) {
        await this.excludePuddleDir(repo);
        mkdirSync(join(repo.path, '.puddle'), { recursive: true });
        return {
          worktreePath: repo.path,
          branch,
          baseBranch: branch,
          baseRef: branch,
          created: false,
        };
      }

      const localExists = await this.refExists(repo, `refs/heads/${branch}`);
      if (!localExists) {
        if (!(await this.refExists(repo, `refs/remotes/origin/${branch}`))) {
          throw ApiError.badRequest('unknown_base', `base branch '${branch}' does not exist`);
        }
        // Only a branch that exists solely on the remote gets a fresh local
        // tracking branch; existing local branches are never reset (SPEC §4).
        await git(['branch', '--track', branch, `origin/${branch}`], { cwd: repo.path });
      }

      // Distinct branches can collide on a slug ('a/b' vs 'a.b'): probe -2,
      // -3, … until we find this branch's own dir or a free name.
      for (let n = 1; ; n++) {
        const slug = slugify(branch) + (n === 1 ? '' : `-${n}`);
        const dir = this.deps.paths.sharedWorktreeDir(repo.id, slug);
        if (existsSync(dir)) {
          const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
          if (head !== branch) continue;
          return { worktreePath: dir, branch, baseBranch: branch, baseRef: branch, created: false };
        }
        mkdirSync(dirname(dir), { recursive: true });
        // --force: the branch may already be checked out in the canonical
        // clone. The double checkout is exactly what this discouraged mode
        // permits — commits land on the branch either way, but each checkout's
        // index and working tree are its own (SPEC §4).
        await git(['worktree', 'add', '--force', dir, branch], { cwd: repo.path });
        await this.excludePuddleDir(repo);
        mkdirSync(join(dir, '.puddle'), { recursive: true });
        return { worktreePath: dir, branch, baseBranch: branch, baseRef: branch, created: true };
      }
    });
  }

  /**
   * The separate_branch = false, separate_worktree = true path (SPEC §4): work
   * directly on the base branch, but in this session's OWN new directory rather
   * than a shared one. Commits land on the base branch (no isolation there);
   * the isolated bit is the working tree, so concurrent sessions on the branch
   * don't trample each other's uncommitted edits. The branch is checked out
   * with `--force` because it is almost always already checked out elsewhere
   * (the canonical clone, or another session's directory).
   */
  createOnBase(opts: {
    repo: Repo;
    sessionId: string;
    baseBranch?: string;
  }): Promise<CreateWorktreeResult> {
    const { repo } = opts;
    return this.runGitMutation(repo.path, async () => {
      await this.deps.storage?.assertAdmission([
        this.deps.paths.home,
        this.deps.paths.worktreesDir,
        repo.path,
      ]);
      const branch = opts.baseBranch ?? (await resolveDefaultBaseBranch(repo));
      await this.fetchCoreQuietly(repo);
      if (!(await this.refExists(repo, `refs/heads/${branch}`))) {
        if (!(await this.refExists(repo, `refs/remotes/origin/${branch}`))) {
          throw ApiError.badRequest('unknown_base', `base branch '${branch}' does not exist`);
        }
        await git(['branch', '--track', branch, `origin/${branch}`], { cwd: repo.path });
      }
      const worktreePath = this.deps.paths.sessionWorktreeDir(repo.id, opts.sessionId);
      mkdirSync(dirname(worktreePath), { recursive: true });
      await git(['worktree', 'add', '--force', worktreePath, branch], { cwd: repo.path });
      await this.excludePuddleDir(repo);
      mkdirSync(join(worktreePath, '.puddle'), { recursive: true });
      return { worktreePath, branch, baseBranch: branch, baseRef: branch, created: true };
    });
  }

  /**
   * A path's identity for comparisons: its realpath, tolerating a path that no
   * longer exists (returned unchanged). Windows compares canonical paths
   * case-insensitively, so git's `C:/Users/...` spelling, a stored
   * `C:\Users\...` and a differently cased registration are one worktree.
   */
  private realOf(p: string): string {
    if (this.platform === 'win32') return canonicalHostPath(p, 'win32').toLowerCase();
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  }

  /**
   * Every git worktree currently checked out for this repo. The primary (main
   * working tree) reports the repo's own clone path verbatim, and any worktree
   * a session already uses reports that session's stored path — so the paths
   * here match `sessions.worktree_path` byte-for-byte (avoiding symlink drift)
   * and can be handed straight back as `join_worktree`. Any other worktree is
   * git's own spelling, made canonical on Windows (git prints `C:/x`).
   */
  async listWorktrees(repo: Repo): Promise<WorktreeInfo[]> {
    const raw = await git(['worktree', 'list', '--porcelain'], { cwd: repo.path });
    const primaryReal = this.realOf(repo.path);
    const sessionByReal = new Map(
      this.deps.sessions.allWorktreePaths().map((p) => [this.realOf(p), p]),
    );

    const out: WorktreeInfo[] = [];
    let path: string | null = null;
    let branch: string | null = null;
    let bare = false;
    const flush = () => {
      if (path && !bare) {
        const real = this.realOf(path);
        const isPrimary = real === primaryReal;
        const canonical = isPrimary
          ? repo.path
          : (sessionByReal.get(real) ?? canonicalHostPath(path, this.platform));
        out.push({ path: canonical, branch, is_primary: isPrimary });
      }
      path = null;
      branch = null;
      bare = false;
    };
    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush();
        path = line.slice('worktree '.length);
      } else if (line === 'bare') bare = true;
      else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      } else if (line === 'detached') branch = null;
    }
    flush();
    return out;
  }

  /**
   * Whether a branch has commits that exist on no remote (purely local work).
   * `rev-list <branch> --not --remotes` lists commits reachable from the branch
   * but from no remote-tracking ref; any at all means unpushed work. A repo
   * with no remote reports its whole history as local-only, which is correct.
   */
  async branchLocalOnly(repo: Repo, branch: string): Promise<boolean> {
    try {
      const out = await git(['rev-list', '--max-count=1', branch, '--not', '--remotes'], {
        cwd: repo.path,
      });
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * `listWorktrees` plus, per worktree, whether it is dirty (uncommitted
   * changes) and whether its branch is local-only — the extra signals the
   * worktree manager (SPEC §8) needs to decide what is safe to prune.
   */
  async listWorktreeStatuses(repo: Repo): Promise<WorktreeInfo[]> {
    const worktrees = await this.listWorktrees(repo);
    const out: WorktreeInfo[] = [];
    for (const w of worktrees) {
      let dirty = false;
      try {
        dirty = !(await this.isClean(w.path));
      } catch {
        // A worktree dir that has vanished can't be dirty in any actionable way.
      }
      const local_only = w.branch ? await this.branchLocalOnly(repo, w.branch) : false;
      out.push({ ...w, dirty, local_only });
    }
    return out;
  }

  /**
   * Local branches that have no worktree checked out — the ones the worktree
   * manager (SPEC §8) may delete (a branch with a worktree must have it pruned
   * first, and git refuses to delete a checked-out branch anyway). Each carries
   * whether it is local-only, so the UI can warn before discarding unpushed work.
   */
  async listOrphanBranches(repo: Repo): Promise<{ name: string; local_only: boolean }[]> {
    const raw = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
      cwd: repo.path,
    });
    const withWorktree = new Set(
      (await this.listWorktrees(repo)).map((w) => w.branch).filter((b): b is string => b !== null),
    );
    const out: { name: string; local_only: boolean }[] = [];
    for (const name of raw.split('\n').filter(Boolean)) {
      if (withWorktree.has(name)) continue;
      out.push({ name, local_only: await this.branchLocalOnly(repo, name) });
    }
    return out;
  }

  /**
   * Land in a specific existing worktree of this repo (SPEC §4, `join_worktree`):
   * validated to be one of the repo's actual worktrees (by realpath), and
   * returned in the canonical form `listWorktrees` uses so it matches other
   * sessions sharing it.
   */
  async joinWorktree(opts: { repo: Repo; worktreePath: string }): Promise<CreateWorktreeResult> {
    const { repo } = opts;
    return this.runGitMutation(repo.path, async () => {
      const wanted = this.realOf(opts.worktreePath);
      const match = (await this.listWorktrees(repo)).find((w) => this.realOf(w.path) === wanted);
      if (!match) {
        throw ApiError.badRequest('unknown_worktree', 'not a worktree of this repository');
      }
      if (!match.branch) {
        throw ApiError.badRequest('detached_worktree', 'that worktree is not on a branch');
      }
      return {
        worktreePath: match.path,
        branch: match.branch,
        baseBranch: match.branch,
        baseRef: match.branch,
        created: false,
      };
    });
  }

  /** `git branch -D` — only ever called for puddle-created session branches (SPEC §4). */
  deleteBranch(repo: Repo, branch: string): Promise<void> {
    return this.runGitMutation(repo.path, async () => {
      await git(['branch', '-D', branch], { cwd: repo.path });
    });
  }

  /** Removes the worktree; the branch stays in the repo (SPEC §4 archiving). */
  remove(opts: { repo: Repo; worktreePath: string; force?: boolean }): Promise<void> {
    return this.runGitMutation(opts.repo.path, async () => {
      // Never remove the repo's own clone — a shared session may have landed in
      // it (SPEC §4), but it is the user's checkout, not a puddle worktree.
      if (this.realOf(opts.worktreePath) === this.realOf(opts.repo.path)) return;
      if (!existsSync(opts.worktreePath)) {
        await git(['worktree', 'prune'], { cwd: opts.repo.path }).catch(() => undefined);
        return;
      }
      if (!opts.force && !(await this.isClean(opts.worktreePath))) {
        throw ApiError.conflict(
          'worktree_dirty',
          'worktree has uncommitted changes; archive with force to discard them',
        );
      }
      const args = ['worktree', 'remove', ...(opts.force ? ['--force'] : []), opts.worktreePath];
      if (this.platform === 'win32') {
        await this.removeOnWindows(opts.repo, opts.worktreePath, args);
        return;
      }
      await git(args, { cwd: opts.repo.path });
    });
  }

  /**
   * `git worktree remove` once nothing holds the tree open (see
   * `assertNotHeldOpen`). Should a handle appear in between, git fails after
   * dropping the registration; the leftover tree is then removed with
   * retries, or reported as busy, and never left registered but half-deleted.
   */
  private async removeOnWindows(repo: Repo, worktreePath: string, args: string[]): Promise<void> {
    assertNotHeldOpen(worktreePath);
    try {
      await git(args, { cwd: repo.path });
      return;
    } catch (error) {
      const wanted = this.realOf(worktreePath);
      const registered = (await this.listWorktrees(repo)).some(
        (w) => this.realOf(w.path) === wanted,
      );
      // Still registered: git refused before deleting anything (dirty, locked).
      if (registered || !existsSync(worktreePath)) throw error;
    }
    try {
      // Linear backoff: about 1.5 s in all before the tree is reported busy.
      rmSync(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      throw worktreeBusy(worktreePath);
    } finally {
      await git(['worktree', 'prune'], { cwd: repo.path }).catch(() => undefined);
    }
  }

  async isClean(worktreePath: string): Promise<boolean> {
    return (await git(['status', '--porcelain'], { cwd: worktreePath })) === '';
  }

  /**
   * Mutexed fetch for project-open, periodic and manual fetches. Throws on
   * failure. `interactive` (Settings' "Fetch now") keeps the inherited
   * environment, so Git Credential Manager can sign the user in on Windows.
   */
  fetchRepo(repo: Repo, opts: { interactive?: boolean } = {}): Promise<void> {
    return this.runGitMutation(repo.path, () => this.fetchCore(repo, opts));
  }

  /**
   * Worktree dirs on disk that no session row claims. Never deletes (SPEC §4).
   * Matched by full path, not dir name: session worktrees are named by session
   * id, shared worktrees by branch slug.
   */
  findOrphanWorktrees(repo: Repo): string[] {
    const dir = join(this.deps.paths.worktreesDir, String(repo.id));
    if (!existsSync(dir)) return [];
    // Windows: a stored path that differs in case or separators is still the same directory.
    const key =
      this.platform === 'win32'
        ? (path: string) => normaliseHostPath(path).toLowerCase()
        : (path: string) => path;
    const known = new Set(this.deps.sessions.allWorktreePaths().map(key));
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => !known.has(key(path)));
  }

  /**
   * Never prompts on Windows unless `interactive`: the other fetches run
   * unattended (see `backgroundGitEnv`).
   */
  private async fetchCore(repo: Repo, opts: { interactive?: boolean } = {}): Promise<void> {
    if (!repo.fetch_enabled) return;
    if (!(await this.hasOrigin(repo))) return; // no remote → freshness degrades silently (SPEC §4)
    const env = opts.interactive ? undefined : backgroundGitEnv(this.platform);
    await git(['fetch', 'origin'], { cwd: repo.path, env });
    this.deps.repos.setLastFetchedAt(repo.id, new Date().toISOString());
  }

  /** Create-time fetch: failures are logged, never block session creation (SPEC §4). */
  private async fetchCoreQuietly(repo: Repo): Promise<void> {
    try {
      await this.fetchCore(repo);
    } catch (e) {
      console.warn(`fetch failed for ${repo.path}: ${(e as Error).message}`);
    }
  }

  private async hasOrigin(repo: Repo): Promise<boolean> {
    const remotes = await git(['remote'], { cwd: repo.path });
    return remotes.split('\n').includes('origin');
  }

  private async refExists(repo: Repo, ref: string): Promise<boolean> {
    try {
      await git(['rev-parse', '--verify', '--quiet', ref], { cwd: repo.path });
      return true;
    } catch {
      return false;
    }
  }

  private async pickBranchName(
    repo: Repo,
    opts: {
      requestedBranch?: string;
      branchPrefix: string;
      title?: string | null;
      prompt?: string | null;
    },
  ): Promise<string> {
    // Human-readable at every fallback: title slug → first words of the
    // prompt → a memorable word triple. Never a uuid fragment.
    const wanted =
      opts.requestedBranch ??
      `${opts.branchPrefix}${slugify(opts.title) || promptSlug(opts.prompt) || memorableName()}`;
    const refs = await git(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
      { cwd: repo.path },
    );
    const taken = new Set(
      refs
        .split('\n')
        .filter(Boolean)
        .map((r) => r.replace(/^origin\//, '')),
    );
    if (!taken.has(wanted)) return wanted;
    for (let n = 2; ; n++) {
      const candidate = `${wanted}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** `.puddle/` is never committed: exclude it once per repo (shared by all worktrees). */
  private async excludePuddleDir(repo: Repo): Promise<void> {
    const commonDirRaw = await git(['rev-parse', '--git-common-dir'], { cwd: repo.path });
    const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(repo.path, commonDirRaw);
    const infoDir = join(commonDir, 'info');
    mkdirSync(infoDir, { recursive: true });
    const excludeFile = join(infoDir, 'exclude');
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    // Windows editors and autocrlf tooling leave CRLF lines; read through them.
    const lines = current.split(this.platform === 'win32' ? /\r?\n/ : '\n');
    if (!lines.includes('.puddle/')) {
      appendFileSync(
        excludeFile,
        (current.endsWith('\n') || current === '' ? '' : '\n') + '.puddle/\n',
      );
    }
  }
}
