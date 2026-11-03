import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LifecycleLaunchContext } from '../adapter.js';
import { lifecycleVersionAtLeast } from '../lifecycle-version.js';
import { interactiveResource } from '../interactive/control.js';
import { turnHookSource } from '../interactive/hook-source.js';
import { claudeHook, runsHelper, type ClaudeCommandHook } from './hook-command.js';

/** Native UserPromptSubmit/Stop payloads, Claude Code 2.1.300 hook contract. */
const SOURCE = turnHookSource(`
  if (input.agent_id) return null;
  const ref = input.session_id;
  if (mode === 'start') return { kind: 'start', ref, prompt: input.prompt };
  if (mode === 'failed') return { kind: 'end', ref, error: input.error_details || input.error || 'Claude turn failed' };
  return { kind: 'end', ref, reply: input.last_assistant_message };
`);

export function installClaudeTurnHooks(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const file = join(configDir, 'puddle-turn.mjs');
  writeFileSync(file, SOURCE, { mode: 0o700 });
  const settingsFile = join(configDir, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
    hooks: Record<string, Array<{ hooks: ClaudeCommandHook[] }>>;
  };
  for (const [event, mode] of [
    ['UserPromptSubmit', 'start'],
    ['Stop', 'complete'],
    ['StopFailure', 'failed'],
  ]) {
    const groups = settings.hooks[event!] ?? [];
    settings.hooks[event!] = [
      ...groups.filter((g) => !g.hooks?.some((h) => runsHelper(h, 'puddle-turn.mjs'))),
      { hooks: [claudeHook(file, [mode!], platform)] },
    ];
  }
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

export async function prepareClaudeInteractive(context: LifecycleLaunchContext) {
  if (!(await lifecycleVersionAtLeast('claude', ['--version'], [2, 1, 300]))) {
    if (await lifecycleVersionAtLeast('claude', ['--version'], [2, 1, 238]))
      return { args: context.args, dispose() {} };
    throw new Error('Claude Code lifecycle hooks are unavailable');
  }
  // StopFailure is version-gated; older normal TUIs keep their existing hooks.
  installClaudeTurnHooks(context.account.config_dir);
  return interactiveResource(context, context.account.config_dir, '\x1b');
}
