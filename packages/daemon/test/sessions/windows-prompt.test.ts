import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertWindowsPromptFits,
  WINDOWS_PROMPT_BUDGET,
} from '../../src/sessions/windows-prompt.js';
import { fixture } from '../helpers/daemon-fixtures.js';
import { sh } from '../helpers/git-fixtures.js';

function refusal(prompt: string | undefined, platform: NodeJS.Platform): unknown {
  try {
    assertWindowsPromptFits(prompt, platform);
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
    expect(refusal(fits, 'win32')).toBeNull();
    expect(refusal(undefined, 'win32')).toBeNull();
    expect(refusal(`${fits}x`, 'win32')).toMatchObject({
      status: 400,
      code: 'prompt_too_long',
      message:
        'on a Windows host the first prompt must fit in 24,000 characters, because Windows ' +
        'limits a command line to 32,767; shorten it by 1',
    });
    for (const platform of ['linux', 'darwin'] as const) {
      expect(refusal('x'.repeat(100_000), platform)).toBeNull();
    }
  });

  it('measures the prompt as quoted on the command line', () => {
    // A space adds the enclosing quotes; an embedded quote also its backslash.
    const spaced = 'a b'.padEnd(WINDOWS_PROMPT_BUDGET - 2, 'x');
    expect(refusal(spaced, 'win32')).toBeNull();
    expect(refusal(`${spaced.slice(1)}"`, 'win32')).toMatchObject({ code: 'prompt_too_long' });
  });

  it.skipIf(process.platform !== 'win32')(
    'leaves no worktree or session behind when SessionService.create refuses',
    async () => {
      const f = fixture();
      const worktrees = sh(f.repoPath, 'worktree', 'list');
      await expect(
        f.service.create({
          project_id: f.ids.project,
          account_id: f.ids.account,
          prompt: 'x'.repeat(WINDOWS_PROMPT_BUDGET + 1),
        }),
      ).rejects.toMatchObject({ status: 400, code: 'prompt_too_long' });
      expect(f.stores.sessions.list()).toEqual([]);
      expect(sh(f.repoPath, 'worktree', 'list')).toBe(worktrees);
      expect(readdirSync(f.paths.worktreesDir)).toEqual([]);
    },
  );
});
