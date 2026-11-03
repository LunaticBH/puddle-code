import { describe, expect, it } from 'vitest';
import { DEFAULT_CONCURRENT_TEMPLATE, DEFAULT_ONBOARDING_TEMPLATE } from '@puddle/shared';
import {
  buildConcurrentWorktreeNote,
  buildOnboardingPreamble,
} from '../../src/sessions/onboarding.js';

describe('launch-text builders', () => {
  it('uses the built-in default when the profile has no onboarding template', () => {
    const text = buildOnboardingPreamble(undefined, 'run make setup', null);
    expect(text).toContain('freshly created git worktree');
    // {{rules}} in the default is replaced with the repo notes.
    expect(text).toContain('run make setup');
    expect(text).not.toContain('{{rules}}');
    // The retired `.puddle/session-title` step is gone.
    expect(text).not.toContain('session-title');
  });

  it('falls back to a placeholder when the repo has no notes', () => {
    const text = buildOnboardingPreamble(DEFAULT_ONBOARDING_TEMPLATE, '   ', null);
    expect(text).toContain('none recorded yet');
  });

  it('substitutes {{rules}} in a custom template and appends the task prompt', () => {
    const text = buildOnboardingPreamble('setup:\n{{rules}}', 'do X', 'now build the feature');
    expect(text).toBe('setup:\ndo X\n\n---\n\nnow build the feature');
  });

  it('treats an empty template as an intentional empty preamble (prompt only)', () => {
    expect(buildOnboardingPreamble('', 'notes', 'just the task')).toBe('just the task');
    // Empty template and no prompt → no launch text at all.
    expect(buildOnboardingPreamble('', 'notes', null)).toBe('');
  });

  it('builds the concurrent note, default or custom, with the prompt appended', () => {
    expect(buildConcurrentWorktreeNote(undefined, null)).toBe(DEFAULT_CONCURRENT_TEMPLATE);
    expect(buildConcurrentWorktreeNote('heads up', 'go')).toBe('heads up\n\n---\n\ngo');
    expect(buildConcurrentWorktreeNote('', null)).toBe('');
  });
});
