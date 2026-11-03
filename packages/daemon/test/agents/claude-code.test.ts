import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Account } from '@puddle/shared';
import { claudeCode } from '../../src/agents/claude-code/index.js';

function account(configDir: string): Account {
  return {
    id: 1,
    profile_id: 1,
    agent_type: 'claude-code',
    label: 'work',
    config_dir: configDir,
    logged_in: true,
    skip_permissions_default: false,
    created_at: '2026-01-01T00:00:00Z',
  };
}

describe('claude-code adapter', () => {
  it('previews only the latest assistant text, excluding tool results and older turns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-cc-preview-'));
    const project = join(dir, 'projects', 'test-project');
    mkdirSync(project, { recursive: true });
    const file = join(project, 'conversation.jsonl');
    const records = [
      { type: 'user', message: { content: 'Fix notifications' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Private reasoning' },
            { type: 'text', text: 'Added conversation previews.' },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', content: 'Tool output must not become the preview' }],
        },
      },
    ];
    writeFileSync(
      file,
      records.map((record) => JSON.stringify(record)).join('\n') + '\n{"partial":',
    );
    expect(await claudeCode.notificationOutput!('conversation', account(dir))).toBe(
      'Added conversation previews.',
    );
    writeFileSync(
      file,
      [...records, { type: 'user', message: { content: 'Now do something else' } }]
        .map((record) => JSON.stringify(record))
        .join('\n'),
    );
    expect(await claudeCode.notificationOutput!('conversation', account(dir))).toBeNull();
  });
  it('seeds a fresh config dir so the first-run wizard never runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-cc-'));
    claudeCode.prepareConfigDir!(dir);
    const state = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    // The wizard re-runs login and discards --session-id; this flag skips it.
    expect(state['hasCompletedOnboarding']).toBe(true);
  });

  it('sums assistant token usage across conversations, or null when none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-cc-'));
    expect(claudeCode.usageStats!(account(dir))).toBeNull();

    const project = join(dir, 'projects', '-Users-alice-src-my-repo');
    mkdirSync(project, { recursive: true });
    const line = (usage: Record<string, number>) =>
      `${JSON.stringify({ type: 'assistant', message: { usage } })}\n`;
    writeFileSync(
      join(project, 'a.jsonl'),
      line({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 }) +
        '{"type":"user"}\n' + // non-assistant rows ignored
        line({ input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 3 }),
    );
    writeFileSync(join(project, 'b.jsonl'), line({ input_tokens: 7, output_tokens: 1 }));

    const usage = claudeCode.usageStats!(account(dir));
    expect(usage).toEqual({
      input_tokens: 157,
      output_tokens: 31,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 3,
      message_count: 3,
    });
  });

  it('reads the session name from the transcript: agent-name wins, else ai-title', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-cc-'));
    const ref = '67194578-8ea8-484a-bb7d-6698b3049cc4';
    // No transcript yet → no name.
    expect(claudeCode.sessionTitle!(ref, account(dir))).toBeNull();

    const project = join(dir, 'projects', '-Users-alice-src-my-repo');
    mkdirSync(project, { recursive: true });
    const path = join(project, `${ref}.jsonl`);

    // ai-title only → that is the name.
    writeFileSync(
      path,
      '{"type":"user"}\n' +
        `${JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the flaky auth test' })}\n`,
    );
    expect(claudeCode.sessionTitle!(ref, account(dir))).toBe('Fix the flaky auth test');

    // An explicit agent-name overrides the generated ai-title.
    writeFileSync(
      path,
      `${JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the flaky auth test' })}\n` +
        `${JSON.stringify({ type: 'agent-name', agentName: 'auth-fix' })}\n`,
    );
    expect(claudeCode.sessionTitle!(ref, account(dir))).toBe('auth-fix');

    // Normalised: whitespace collapsed, trimmed, capped.
    writeFileSync(path, `${JSON.stringify({ type: 'ai-title', aiTitle: '  a\t b  ' })}\n`);
    expect(claudeCode.sessionTitle!(ref, account(dir))).toBe('a b');
  });

  it('finds a title near the head even when the transcript has since grown large', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-cc-'));
    const ref = 'aaaaaaaa-8ea8-484a-bb7d-6698b3049cc4';
    const project = join(dir, 'projects', '-Users-alice-src-my-repo');
    mkdirSync(project, { recursive: true });
    // Title lands early; a fat body follows with no further title line, pushing
    // it out of the tail window — the head fallback must still find it.
    const filler = `${'{"type":"assistant","message":{"usage":{}}}'.padEnd(500, ' ')}\n`.repeat(
      1000,
    );
    writeFileSync(
      join(project, `${ref}.jsonl`),
      `${JSON.stringify({ type: 'ai-title', aiTitle: 'early title' })}\n${filler}`,
    );
    expect(claudeCode.sessionTitle!(ref, account(dir))).toBe('early title');
  });

  it('finds conversations in any escaped project dir, and only real ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-cc-'));
    const ref = '67194578-8ea8-484a-bb7d-6698b3049cc4';
    // No projects dir at all → no conversation.
    expect(claudeCode.hasConversation!(ref, account(dir))).toBe(false);
    // Worktree sessions store under the MAIN repo's escaped path, so the
    // lookup must scan project dirs rather than derive one from the cwd.
    const project = join(dir, 'projects', '-Users-alice-src-my-repo');
    mkdirSync(project, { recursive: true });
    expect(claudeCode.hasConversation!(ref, account(dir))).toBe(false);
    writeFileSync(join(project, `${ref}.jsonl`), '{}\n');
    expect(claudeCode.hasConversation!(ref, account(dir))).toBe(true);
    expect(claudeCode.hasConversation!('someone-else', account(dir))).toBe(false);
  });

  it('catalogues cached normalised metadata without reading full transcripts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-cc-'));
    const ref = '77194578-8ea8-484a-bb7d-6698b3049cc4';
    const project = join(dir, 'projects', '-Users-alice-src-my-repo');
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, `${ref}.jsonl`),
      `${JSON.stringify({ type: 'user', cwd: '/worktree' })}\n` +
        `${JSON.stringify({ type: 'ai-title', aiTitle: 'Native title' })}\n`,
    );
    const first = await claudeCode.conversationDiscovery?.discover(account(dir));
    expect(first).toEqual([
      expect.objectContaining({ ref, cwd: '/worktree', title: 'Native title' }),
    ]);
    expect(await claudeCode.conversationDiscovery?.discover(account(dir))).toEqual(first);
  });
});
