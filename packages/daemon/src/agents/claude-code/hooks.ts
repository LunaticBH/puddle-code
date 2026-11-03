import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeHook, runsHelper, type ClaudeCommandHook } from './hook-command.js';

/**
 * Hook-driven status signals for claude-code (SPEC §4/§5): the reliable
 * replacement for scraping the TUI with regexes. Claude Code fires documented
 * hook events at exactly the moments puddle's status machine cares about, so
 * we install a tiny helper into the account's config dir and register it for:
 *
 *   Stop                              → waiting_input (turn finished)
 *   Notification(permission_prompt)   → waiting_input (approval needed)
 *   Notification(idle_prompt)         → waiting_input (idle at the prompt)
 *   UserPromptSubmit                  → working       (a prompt went in)
 *   PreToolUse                        → working       (tool call — also the
 *                                       resume-after-approval moment, which
 *                                       fires no UserPromptSubmit)
 *   SessionStart                     → native start  (startup/resume/clear/
 *                                       compact/fork, exact source + ref)
 *   SessionEnd                       → native end
 *
 * The helper POSTs `{nonce, state}` to the daemon's /agent-signal endpoint;
 * both values arrive via env vars the daemon injects into the agent PTY at
 * spawn (hook processes inherit the agent's environment). Outside puddle the
 * vars are absent and the helper exits silently, so the hooks are inert for
 * a `claude` run by hand against the same config dir. Hooks in the config
 * dir's settings.json apply to every session using that CLAUDE_CONFIG_DIR
 * (verified against Claude Code 2.1.219, like the event timing above).
 */
const HELPER_FILE = 'puddle-signal.mjs';

const HELPER_SOURCE = `// puddle agent signal (managed by puddled — safe to delete, reinstalled at boot)
const mode = process.argv[2];
const value = process.argv[3];
const url = process.env.PUDDLE_AGENT_SIGNAL_URL;
const nonce = process.env.PUDDLE_AGENT_SIGNAL_NONCE;
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
if (!url || !nonce) process.exit(0);
let body;
if (mode === 'status' && (value === 'working' || value === 'waiting_input')) {
  body = { nonce, state: value };
} else if (mode === 'lifecycle') {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  if (input.agent_id) process.exit(0);
  const start = value === 'session_start';
  const allowed = new Set(['startup', 'resume', 'clear', 'fork', 'compact']);
  const source = start && allowed.has(input.source) ? input.source : 'exit';
  const parent = input.parent_session_id ?? input.parentSessionId ?? input.parent_agent_session_ref;
  body = {
    nonce,
    event: start ? 'session_start' : 'session_end',
    ...(typeof input.session_id === 'string' ? { agent_session_ref: input.session_id } : {}),
    cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(),
    source,
    ...(typeof parent === 'string' ? { parent_agent_session_ref: parent } : {}),
  };
} else {
  process.exit(0);
}
try {
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1500),
  });
} catch {
  // The daemon being unreachable must never disturb the agent.
}
process.exit(0);
`;

/** Hook registrations, one per (event, matcher) — see the module doc. */
type HookEvent =
  | { event: string; matcher?: string; mode: 'status'; value: 'working' | 'waiting_input' }
  | { event: string; mode: 'lifecycle'; value: 'session_start' | 'session_end' };

const HOOK_EVENTS: HookEvent[] = [
  { event: 'Stop', mode: 'status', value: 'waiting_input' },
  { event: 'Notification', matcher: 'permission_prompt', mode: 'status', value: 'waiting_input' },
  { event: 'Notification', matcher: 'idle_prompt', mode: 'status', value: 'waiting_input' },
  { event: 'UserPromptSubmit', mode: 'status', value: 'working' },
  { event: 'PreToolUse', mode: 'status', value: 'working' },
  { event: 'SessionStart', mode: 'lifecycle', value: 'session_start' },
  { event: 'SessionEnd', mode: 'lifecycle', value: 'session_end' },
];

interface HookGroup {
  matcher?: string;
  hooks: ClaudeCommandHook[];
}

/**
 * Installs the signal helper and registers the hook entries in the config
 * dir's settings.json. Idempotent, and additive to the user's own hooks: only
 * groups whose commands reference our helper are replaced; everything else in
 * the file (including foreign hooks on the same events) is preserved.
 */
export function installStatusHooks(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const helperPath = join(configDir, HELPER_FILE);
  writeFileSync(helperPath, HELPER_SOURCE, { mode: 0o700 });

  const settingsFile = join(configDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
    } catch {
      // A corrupt settings file is replaced by one carrying only our hooks.
    }
  }
  const hooks =
    settings['hooks'] && typeof settings['hooks'] === 'object'
      ? (settings['hooks'] as Record<string, unknown>)
      : {};

  // Collate our groups per event FIRST — an event can carry several matchers
  // (Notification), and filtering per entry would strip the sibling just added.
  const byEvent = new Map<string, HookGroup[]>();
  for (const hook of HOOK_EVENTS) {
    const { event, mode, value } = hook;
    const ours: HookGroup = {
      ...('matcher' in hook && hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
      hooks: [claudeHook(helperPath, [mode, value], platform)],
    };
    byEvent.set(event, [...(byEvent.get(event) ?? []), ours]);
  }
  for (const [event, oursList] of byEvent) {
    const groups: HookGroup[] = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];
    const foreign = groups.filter((g) => !(g?.hooks ?? []).some((h) => runsHelper(h, HELPER_FILE)));
    hooks[event] = [...foreign, ...oursList];
  }

  settings['hooks'] = hooks;
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}
