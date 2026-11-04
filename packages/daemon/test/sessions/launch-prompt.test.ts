import { describe, expect, it } from 'vitest';
import { launchPrompt, worktreeFreshness } from '../../src/sessions/launch-prompt.js';
import {
  buildConcurrentWorktreeNote,
  buildOnboardingPreamble,
} from '../../src/sessions/onboarding.js';

/**
 * What a new agent session's launch sends as its first prompt, known before
 * its worktree is resolved, so a Windows host can refuse one too long for a
 * command line without leaving a worktree or session behind.
 */
describe('agent launch prompt', () => {
  const settings = { onboardingTemplate: 'Onboard: {{rules}}', concurrentTemplate: 'Shared.' };

  it('onboards a fresh worktree and notes a reused one', () => {
    expect(launchPrompt(settings, 'rules', 'task', true)).toBe(
      buildOnboardingPreamble(settings.onboardingTemplate, 'rules', 'task'),
    );
    expect(launchPrompt(settings, 'rules', 'task', false)).toBe(
      buildConcurrentWorktreeNote(settings.concurrentTemplate, 'task'),
    );
    expect(launchPrompt({}, null, undefined, false)).toBe(
      buildConcurrentWorktreeNote(undefined, null),
    );
  });

  it('predicts whether the worktree may be fresh', () => {
    const joined = { join_worktree: '/repo' };
    expect(worktreeFreshness(joined, false, false)).toEqual([false]);
    expect(worktreeFreshness({}, true, true)).toEqual([true]);
    expect(worktreeFreshness({}, false, true)).toEqual([true]);
    // The base branch's shared worktree is created by its first session only.
    expect(worktreeFreshness({}, false, false)).toEqual([true, false]);
  });
});
