import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertWindowsPromptFits,
  WINDOWS_PROMPT_BUDGET,
} from '../../src/sessions/windows-prompt.js';
import { fixture, type Fixture } from '../helpers/daemon-fixtures.js';
import { sh } from '../helpers/git-fixtures.js';

function refusal(launchPrompts: readonly string[], platform: NodeJS.Platform): unknown {
  try {
    assertWindowsPromptFits(() => launchPrompts, platform);
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * An interactive agent's first prompt is one command-line argument, and
 * Windows caps a command line at 32,767 characters, so a Windows host refuses
 * a longer prompt up front instead of failing the spawn with error 206.
 */
describe('Windows first-prompt budget', () => {
  it('refuses a quoted prompt past the budget on a Windows host only', () => {
    const fits = 'x'.repeat(WINDOWS_PROMPT_BUDGET);
    expect(refusal([fits], 'win32')).toBeNull();
    expect(refusal([], 'win32')).toBeNull();
    expect(refusal([`${fits}x`], 'win32')).toMatchObject({
      status: 400,
      code: 'prompt_too_long',
      message:
        'on a Windows host the first prompt and the launch text before it, onboarding notes ' +
        'included, must fit in 24,000 characters, because Windows limits a command line to ' +
        '32,767; shorten them by 1',
    });
    for (const platform of ['linux', 'darwin'] as const) {
      expect(refusal(['x'.repeat(100_000)], platform)).toBeNull();
    }
  });

  it('measures the longest launch prompt the session may get', () => {
    const fits = 'x'.repeat(WINDOWS_PROMPT_BUDGET);
    expect(refusal(['short', `${fits}xyz`, fits], 'win32')).toMatchObject({
      code: 'prompt_too_long',
      message: expect.stringMatching(/shorten them by 3$/),
    });
  });

  it('composes no launch prompt on a POSIX host', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(() =>
        assertWindowsPromptFits(() => {
          throw new Error('composed on POSIX');
        }, platform),
      ).not.toThrow();
    }
  });

  it('measures the prompt as quoted on the command line', () => {
    // A space adds the enclosing quotes; an embedded quote also its backslash.
    const spaced = 'a b'.padEnd(WINDOWS_PROMPT_BUDGET - 2, 'x');
    expect(refusal([spaced], 'win32')).toBeNull();
    expect(refusal([`${spaced.slice(1)}"`], 'win32')).toMatchObject({ code: 'prompt_too_long' });
  });

  describe.skipIf(process.platform !== 'win32')('SessionService.create on Windows', () => {
    /** Creating must refuse with nothing left behind: no row, worktree or directory. */
    async function expectRefusedCleanly(f: Fixture, prompt: string): Promise<void> {
      const worktrees = sh(f.repoPath, 'worktree', 'list');
      await expect(
        f.service.create({ project_id: f.ids.project, account_id: f.ids.account, prompt }),
      ).rejects.toMatchObject({ status: 400, code: 'prompt_too_long' });
      expect(f.stores.sessions.list()).toEqual([]);
      expect(sh(f.repoPath, 'worktree', 'list')).toBe(worktrees);
      expect(readdirSync(f.paths.worktreesDir)).toEqual([]);
    }

    it('refuses a prompt past the budget', async () => {
      await expectRefusedCleanly(fixture(), 'x'.repeat(WINDOWS_PROMPT_BUDGET + 1));
    });

    it('refuses a prompt within the budget that long onboarding notes push past it', async () => {
      const f = fixture();
      f.stores.repos.setOnboardingNotes(f.ids.repo, 'n'.repeat(20_000));
      await expectRefusedCleanly(f, 'x'.repeat(10_000));
    });

    it('measures only the concurrency note for a joined worktree', async () => {
      const f = fixture();
      f.stores.repos.setOnboardingNotes(f.ids.repo, 'n'.repeat(20_000));
      const session = await f.service.create({
        project_id: f.ids.project,
        account_id: f.ids.account,
        separate_branch: false,
        separate_worktree: false,
        join_worktree: f.repoPath,
        prompt: 'x'.repeat(10_000),
      });
      expect(f.stores.sessions.list().map((s) => s.id)).toEqual([session.id]);
      await f.service.kill(session.id).catch(() => undefined);
    });
  });
});
