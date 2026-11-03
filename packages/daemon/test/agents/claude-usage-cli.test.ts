import { describe, expect, it } from 'vitest';
import { parseUsageOutput } from '../../src/agents/claude-code/usage-cli.js';

// The exact `claude -p /usage` shape this parser was written against
// (Claude Code 2.1.209).
const REAL_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 43% used · resets Jul 14 at 6:49am (America/Los_Angeles)
Current week (all models): 28% used · resets Jul 20 at 3:59am (America/Los_Angeles)
Current week (Fable): 47% used · resets Jul 20 at 3:59am (America/Los_Angeles)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 1042 requests · 5 sessions
  96% of your usage came from subagent-heavy sessions
`;

describe('claude -p /usage parsing', () => {
  it('extracts every window with its label, percentage, and reset text', () => {
    const windows = parseUsageOutput(REAL_OUTPUT);
    expect(windows).toEqual([
      { key: 'session', label: 'session', used_percentage: 43, resets: 'Jul 14 at 6:49am' },
      {
        key: 'week-all-models',
        label: 'week (all models)',
        used_percentage: 28,
        resets: 'Jul 20 at 3:59am',
      },
      { key: 'week-fable', label: 'week (Fable)', used_percentage: 47, resets: 'Jul 20 at 3:59am' },
    ]);
  });

  it('does not mistake the contribution percentages for windows', () => {
    const windows = parseUsageOutput(REAL_OUTPUT) ?? [];
    expect(windows).toHaveLength(3);
  });

  it('tolerates a missing reset clause', () => {
    const windows = parseUsageOutput('Current session: 12% used');
    expect(windows).toEqual([
      { key: 'session', label: 'session', used_percentage: 12, resets: null },
    ]);
  });

  it('yields null for API-key output (no window lines at all)', () => {
    // With ANTHROPIC_API_KEY set the CLI prints only session cost totals —
    // the subscription windows are silently omitted (verified 2.1.209).
    const apiKeyOutput = `Total cost:            $0.0000
Total duration (API):  0s
Usage:                 0 input, 0 output, 0 cache read, 0 cache write
`;
    expect(parseUsageOutput(apiKeyOutput)).toBeNull();
    expect(parseUsageOutput('')).toBeNull();
  });
});
