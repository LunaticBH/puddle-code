import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Account, Session } from '@puddle/shared';
import type { AgentAdapter } from '../../src/agents/adapter.js';
import { LogStore } from '../../src/logs/log-store.js';
import { quoteWindowsArgument } from '../../src/pty/pty-spawn.js';
import { buildHandoffPrompt } from '../../src/sessions/handoff.js';
import { initRepo } from '../helpers/git-fixtures.js';

/**
 * The hand-off prompt travels as one command-line argument. Windows caps a
 * command line at 32,767 characters after quoting, so there the prompt is
 * bounded; POSIX keeps the full transcript budget and unbounded git sections.
 */
describe('hand-off prompt budget', () => {
  function sources(transcript: string) {
    const repo = initRepo();
    // An untracked file per line of `git status --short`.
    for (let i = 0; i < 600; i++) writeFileSync(join(repo, `untracked-${i}.txt`), '');
    const adapter = {
      displayName: 'Fake',
      exportTranscript: async () => transcript,
    } as unknown as AgentAdapter;
    const session = {
      id: 's',
      agent_session_ref: 'ref',
      base_branch: 'main',
      branch: 'main',
      worktree_path: repo,
    } as unknown as Session;
    const logs = new LogStore(mkdtempSync(join(tmpdir(), 'puddle-logs-')), 1024);
    return { adapter, account: {} as Account, session, logs };
  }

  // Quote-heavy, so quoting grows it, and longer than the transcript budget.
  const transcript = Array.from({ length: 800 }, (_, i) => `turn ${i}: "quoted" \\"x\\"`).join(
    '\n',
  );

  it('keeps the quoted Windows prompt inside the command-line limit', async () => {
    const prompt = await buildHandoffPrompt(sources(transcript), 'win32');
    expect(quoteWindowsArgument(prompt).length).toBeLessThanOrEqual(24_000);
    expect(prompt).toContain('_(earlier turns omitted)_');
    expect(prompt).toContain('turn 799');
    expect(prompt).toMatch(/… \(\d+ more lines omitted\)/);
  });

  it('leaves the POSIX prompt unbounded beyond the transcript budget', async () => {
    const prompt = await buildHandoffPrompt(sources(transcript), 'linux');
    expect(prompt).not.toContain('more lines omitted');
    expect(prompt).toContain('untracked-599.txt');
    expect(prompt.length).toBeGreaterThan(24_000);
  });
});
