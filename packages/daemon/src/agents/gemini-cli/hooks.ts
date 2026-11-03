import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installGeminiTurnHooks } from './control.js';
import { geminiHookCommand } from './hook-command.js';

const HELPER_FILE = 'puddle-signal.mjs';

const HELPER_SOURCE = `// puddle lifecycle signal (managed by puddled — safe to delete, reinstalled at boot)
const event = process.argv[2];
const url = process.env.PUDDLE_AGENT_SIGNAL_URL;
const nonce = process.env.PUDDLE_AGENT_SIGNAL_NONCE;
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
if (url && nonce) {
  try {
    const input = JSON.parse(raw || '{}');
    const start = event === 'session_start';
    const allowed = new Set(['startup', 'resume', 'clear']);
    const source = start && allowed.has(input.source) ? input.source : 'exit';
    const parent = input.parent_session_id ?? input.parentSessionId ?? input.parent_agent_session_ref;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nonce,
        event: start ? 'session_start' : 'session_end',
        ...(typeof input.session_id === 'string' ? { agent_session_ref: input.session_id } : {}),
        cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(),
        source,
        ...(typeof parent === 'string' ? { parent_agent_session_ref: parent } : {}),
      }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Lifecycle reporting must never disturb Gemini.
  }
}
// Gemini command hooks consume a JSON decision object from stdout.
process.stdout.write('{}\\n');
`;

interface HookGroup {
  matcher?: string;
  hooks: Array<{ name: string; type: string; command: string }>;
}

/** Additive SessionStart/SessionEnd hooks, verified for Gemini CLI 0.53.x. */
export function installGeminiLifecycleHooks(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const dir = join(configDir, '.gemini');
  mkdirSync(dir, { recursive: true });
  const helperPath = join(dir, HELPER_FILE);
  writeFileSync(helperPath, HELPER_SOURCE, { mode: 0o700 });

  const settingsPath = join(dir, 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // A corrupt settings file is replaced by the minimal managed hooks.
    }
  }
  const hooks =
    settings['hooks'] && typeof settings['hooks'] === 'object'
      ? (settings['hooks'] as Record<string, unknown>)
      : {};
  for (const [event, signal] of [
    ['SessionStart', 'session_start'],
    ['SessionEnd', 'session_end'],
  ] as const) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];
    const foreign = groups.filter(
      (group) => !(group.hooks ?? []).some((hook) => hook.command?.includes(HELPER_FILE)),
    );
    hooks[event] = [
      ...foreign,
      {
        hooks: [
          {
            name: `puddle-${signal}`,
            type: 'command',
            command: geminiHookCommand(helperPath, [signal], platform),
          },
        ],
      } satisfies HookGroup,
    ];
  }
  settings['hooks'] = hooks;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  installGeminiTurnHooks(configDir, platform);
}
