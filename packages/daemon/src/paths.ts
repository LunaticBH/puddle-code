import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { hostPathStyle, normaliseHostPath } from '@puddle/shared';
import { initialisePrivateHome } from '@puddle/shared/node';
import { canonicalHostPath } from './host-path.js';

/** Every filesystem location the daemon touches, derived from one home dir. */
export interface PuddlePaths {
  home: string;
  dbFile: string;
  tokenFile: string;
  configFile: string;
  /** Records where the daemon actually bound, so clients discover the live port. */
  runtimeFile: string;
  profilesDir: string;
  worktreesDir: string;
  logsDir: string;
  /** Generated shell hook scripts for captured-env reporting (SPEC §4). */
  shellHooksDir: string;
  accountConfigDir(profileId: string, agentType: string, label: string): string;
  /**
   * Per-profile canonical store for adopted agent conversations (Workstream S).
   * A conversation's project dir is renamed here once and symlinked back into
   * every account of the (profile, agent) so the same agent can resume it under
   * a different account without moving files.
   */
  profileSessionsDir(profileId: string, agentType: string): string;
  sessionWorktreeDir(repoId: number, sessionId: string): string;
  /** Shared per-(repo, branch) worktree for separate_branch = false sessions (SPEC §4). */
  sharedWorktreeDir(repoId: number, branchSlug: string): string;
  sessionLogDir(sessionId: string): string;
}

/**
 * Windows spells the home canonically (decision 11), so every path derived
 * from it, `sessions.worktree_path` included, is canonical too. Only the
 * parent is resolved: a junction as the home itself must stay visible to
 * `initialisePrivateHome`, which refuses it. POSIX homes are used as given.
 */
export function canonicalHome(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || hostPathStyle(home) !== 'win32') return home;
  const normalised = win32.normalize(home);
  const trimmed =
    normalised === win32.parse(normalised).root ? normalised : normalised.replace(/\\+$/, '');
  const parent = win32.dirname(trimmed);
  if (parent === trimmed) return normaliseHostPath(trimmed);
  return win32.join(canonicalHostPath(parent, platform), win32.basename(trimmed));
}

export function resolvePaths(
  requested: string = process.env.PUDDLE_HOME ?? join(homedir(), '.puddle'),
): PuddlePaths {
  const home = canonicalHome(requested);
  return {
    home,
    dbFile: join(home, 'puddle.db'),
    tokenFile: join(home, 'token'),
    configFile: join(home, 'config.json'),
    runtimeFile: join(home, 'runtime.json'),
    profilesDir: join(home, 'profiles'),
    worktreesDir: join(home, 'worktrees'),
    logsDir: join(home, 'logs'),
    shellHooksDir: join(home, 'shell-hooks'),
    accountConfigDir: (profileId, agentType, label) =>
      join(home, 'profiles', profileId, 'accounts', agentType, label),
    profileSessionsDir: (profileId, agentType) =>
      join(home, 'profiles', profileId, 'sessions', agentType),
    sessionWorktreeDir: (repoId, sessionId) => join(home, 'worktrees', String(repoId), sessionId),
    sharedWorktreeDir: (repoId, branchSlug) =>
      join(home, 'worktrees', String(repoId), `branch-${branchSlug}`),
    sessionLogDir: (sessionId) => join(home, 'logs', sessionId),
  };
}

export function ensureHome(paths: PuddlePaths): void {
  initialisePrivateHome(paths.home);
  mkdirSync(paths.profilesDir, { recursive: true });
  mkdirSync(paths.worktreesDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
}
