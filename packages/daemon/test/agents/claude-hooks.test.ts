import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installStatusHooks } from '../../src/agents/claude-code/hooks.js';
import { installClaudeTurnHooks } from '../../src/agents/claude-code/control.js';

interface Hook {
  type: string;
  command: string;
  args?: string[];
}
interface HookGroup {
  matcher?: string;
  hooks: Hook[];
}
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'puddle-claude-hooks-'));
}
function readSettings(configDir: string): Settings {
  return JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as Settings;
}
/** A hook's whole invocation, whichever form the platform installs. */
function invocation(hook: Hook): string {
  return [hook.command, ...(hook.args ?? [])].join(' ');
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
    expect(invocation(s.hooks!['Stop']![0]!.hooks[0]!)).toContain('puddle-signal.mjs');
    expect(invocation(s.hooks!['Stop']![0]!.hooks[0]!)).toMatch(/status waiting_input$/);
    expect(invocation(s.hooks!['PreToolUse']![0]!.hooks[0]!)).toMatch(/status working$/);
    expect(invocation(s.hooks!['SessionStart']![0]!.hooks[0]!)).toMatch(/lifecycle session_start$/);
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
    expect(stop.filter((g) => invocation(g.hooks[0]!).includes('puddle-signal.mjs'))).toHaveLength(
      1,
    );
    expect(s.hooks!['Notification']).toHaveLength(2);
  });

  it('keeps the POSIX shell form: quoted node and helper, then the arguments', () => {
    const configDir = dir();
    installStatusHooks(configDir, 'linux');
    const hook = readSettings(configDir).hooks!['Stop']![0]!.hooks[0]!;
    expect(hook).toEqual({
      type: 'command',
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(configDir, 'puddle-signal.mjs'))} status waiting_input`,
    });
  });

  it('uses exec form on Windows, so no shell parses the paths', () => {
    const configDir = dir();
    installStatusHooks(configDir, 'win32');
    const hook = readSettings(configDir).hooks!['Stop']![0]!.hooks[0]!;
    expect(hook).toEqual({
      type: 'command',
      command: process.execPath,
      args: [join(configDir, 'puddle-signal.mjs'), 'status', 'waiting_input'],
    });
  });

  it('replaces a shell-form registration with exec form when reinstalled on Windows', () => {
    const configDir = dir();
    installStatusHooks(configDir, 'linux');
    installStatusHooks(configDir, 'win32');
    const stop = readSettings(configDir).hooks!['Stop']!;
    expect(stop).toHaveLength(1);
    expect(stop[0]!.hooks[0]!.args).toBeDefined();
  });
});

describe('installClaudeTurnHooks', () => {
  it('registers the turn helper in exec form on Windows, idempotently', () => {
    const configDir = dir();
    installStatusHooks(configDir, 'win32');
    installClaudeTurnHooks(configDir, 'win32');
    installClaudeTurnHooks(configDir, 'win32');
    const s = readSettings(configDir);
    const ours = s.hooks!['UserPromptSubmit']!.filter((g) =>
      invocation(g.hooks[0]!).includes('puddle-turn.mjs'),
    );
    expect(ours).toEqual([
      {
        hooks: [
          {
            type: 'command',
            command: process.execPath,
            args: [join(configDir, 'puddle-turn.mjs'), 'start'],
          },
        ],
      },
    ]);
    expect(invocation(s.hooks!['StopFailure']![0]!.hooks[0]!)).toMatch(/puddle-turn\.mjs failed$/);
  });
});
