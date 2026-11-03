import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installStatusHooks } from '../../src/agents/claude-code/hooks.js';

interface HookGroup {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'puddle-claude-hooks-'));
}
function readSettings(configDir: string): Settings {
  return JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as Settings;
}

describe('installStatusHooks', () => {
  it('registers status and lifecycle signal hooks and writes the helper', () => {
    const configDir = dir();
    installStatusHooks(configDir);
    const s = readSettings(configDir);
    expect(Object.keys(s.hooks ?? {}).sort()).toEqual([
      'Notification',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    // Notification carries one group per matcher; both flag waiting_input.
    expect(s.hooks!['Notification']!.map((g) => g.matcher).sort()).toEqual([
      'idle_prompt',
      'permission_prompt',
    ]);
    expect(s.hooks!['Stop']![0]!.hooks[0]!.command).toContain('puddle-signal.mjs');
    expect(s.hooks!['Stop']![0]!.hooks[0]!.command).toMatch(/status waiting_input$/);
    expect(s.hooks!['PreToolUse']![0]!.hooks[0]!.command).toMatch(/status working$/);
    expect(s.hooks!['SessionStart']![0]!.hooks[0]!.command).toMatch(/lifecycle session_start$/);
    expect(readFileSync(join(configDir, 'puddle-signal.mjs'), 'utf8')).toContain(
      'PUDDLE_AGENT_SIGNAL_URL',
    );
  });

  it('is idempotent and preserves foreign hooks and settings', () => {
    const configDir = dir();
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: 'my-own-statusline' },
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'my-own-stop-hook' }] }],
        },
      }),
    );
    installStatusHooks(configDir);
    installStatusHooks(configDir); // double install must not duplicate
    const s = readSettings(configDir);
    expect(s['statusLine']).toEqual({ type: 'command', command: 'my-own-statusline' });
    const stop = s.hooks!['Stop']!;
    expect(stop.filter((g) => g.hooks[0]!.command === 'my-own-stop-hook')).toHaveLength(1);
    expect(stop.filter((g) => g.hooks[0]!.command.includes('puddle-signal.mjs'))).toHaveLength(1);
    expect(s.hooks!['Notification']).toHaveLength(2);
  });
});
