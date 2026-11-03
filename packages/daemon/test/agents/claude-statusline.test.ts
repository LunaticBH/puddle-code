import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execPath } from 'node:process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installStatusLine, readLiveUsage } from '../../src/agents/claude-code/statusline.js';

describe('claude-code status line capture', () => {
  it('installs a statusLine command without clobbering an existing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-sl-'));
    installStatusLine(dir);
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
      statusLine?: { command: string };
    };
    expect(settings.statusLine?.command).toContain('puddle-statusline.mjs');

    // A user-defined status line is respected on re-install.
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }),
    );
    installStatusLine(dir);
    const after = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
      statusLine?: { command: string };
    };
    expect(after.statusLine?.command).toBe('mine');
  });

  it('the helper records the fields puddle surfaces and prints a status line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-sl-'));
    installStatusLine(dir);
    expect(readLiveUsage(dir)).toBeNull(); // nothing captured yet

    // Feed the helper a real-shaped payload exactly as Claude Code would.
    const payload = JSON.stringify({
      context_window: { used_percentage: 42.7 },
      cost: { total_cost_usd: 0 },
      model: { display_name: 'Fable 5' },
    });
    const line = execFileSync(execPath, [join(dir, 'puddle-statusline.mjs')], {
      input: payload,
      encoding: 'utf8',
    });
    expect(line).toContain('Fable 5');
    expect(line).toContain('43%'); // rounded

    const usage = readLiveUsage(dir);
    expect(usage?.context_used_percentage).toBe(42.7);
    expect(usage?.model).toBe('Fable 5');
    expect(typeof usage?.captured_at).toBe('string');
  });

  it('tolerates a malformed payload without writing junk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-sl-'));
    installStatusLine(dir);
    const line = execFileSync(execPath, [join(dir, 'puddle-statusline.mjs')], {
      input: 'not json',
      encoding: 'utf8',
    });
    expect(line).toBe('');
    expect(existsSync(join(dir, 'puddle-status.json'))).toBe(false);
  });
});
