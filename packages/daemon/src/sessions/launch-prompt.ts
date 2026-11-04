import type { CreateSessionRequest, ProfileSettings } from '@puddle/shared';
import { buildConcurrentWorktreeNote, buildOnboardingPreamble } from './onboarding.js';

/**
 * The first prompt a new agent session's launch sends (SPEC §4): the task
 * prompt after the profile's onboarding preamble in a freshly created
 * worktree, or after its concurrency note in a reused one. An empty result
 * means the launch sends no prompt.
 */
export function launchPrompt(
  settings: Pick<ProfileSettings, 'onboardingTemplate' | 'concurrentTemplate'>,
  notes: string | null,
  taskPrompt: string | undefined,
  fresh: boolean,
): string {
  return fresh
    ? buildOnboardingPreamble(settings.onboardingTemplate, notes, taskPrompt ?? null)
    : buildConcurrentWorktreeNote(settings.concurrentTemplate, taskPrompt ?? null);
}

/**
 * Whether the worktree a new agent session lands in can be fresh, known before
 * SessionService resolves it: a joined worktree is always a reuse and a
 * directory of the session's own always new, while the base branch's shared
 * worktree is created by its first session only, so it may be either.
 */
export function worktreeFreshness(
  input: Pick<CreateSessionRequest, 'join_worktree'>,
  separateBranch: boolean,
  separateWorktree: boolean,
): readonly boolean[] {
  if (input.join_worktree !== undefined) return [false];
  return separateBranch || separateWorktree ? [true] : [true, false];
}
