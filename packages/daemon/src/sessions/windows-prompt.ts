import { ApiError } from '../http/errors.js';
import { quoteWindowsArgument } from '../pty/pty-spawn.js';

/**
 * Windows only: an interactive agent receives its first prompt as one
 * command-line argument, and CreateProcess caps the whole line at 32,767
 * characters after quoting (docs/windows.md, decision 9). A quoted prompt
 * within this budget, launch text included, leaves room for the executable,
 * its script and the flags; the hand-off prompt is composed to fit it.
 */
export const WINDOWS_PROMPT_BUDGET = 24_000;

/** How far `prompt`, quoted for a command line, runs past the budget; at most 0 when it fits. */
export function windowsPromptOverflow(prompt: string): number {
  return quoteWindowsArgument(prompt).length - WINDOWS_PROMPT_BUDGET;
}

/**
 * Refuses, before a worktree or session exists, a first prompt that a
 * Windows host could not hand to an interactive agent. `launchPrompts`
 * returns each text the launch may send: the task prompt after whichever
 * launch text (onboarding preamble or concurrency note) it can get, so the
 * longest is what is measured. It runs on Windows only; POSIX hosts compose
 * nothing here and allow the prompt their exec limits allow, as before.
 */
export function assertWindowsPromptFits(
  launchPrompts: () => readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') return;
  const overflow = Math.max(0, ...launchPrompts().map(windowsPromptOverflow));
  if (overflow === 0) return;
  throw ApiError.badRequest(
    'prompt_too_long',
    `on a Windows host the first prompt and the launch text before it, onboarding notes ` +
      `included, must fit in ${WINDOWS_PROMPT_BUDGET.toLocaleString('en-GB')} characters, ` +
      `because Windows limits a command line to 32,767; shorten them by ` +
      `${overflow.toLocaleString('en-GB')}`,
  );
}
