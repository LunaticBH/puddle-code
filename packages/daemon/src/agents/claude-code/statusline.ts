import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment } from '@puddle/shared/node/platform';
import { claudeStatusLineCommand, claudeStatusLineShell, runsHelper } from './hook-command.js';

/**
 * Live per-session usage capture for claude-code, via the documented
 * statusLine mechanism (SPEC §5). Claude Code invokes a status-line command
 * on every session update, passing a JSON payload on stdin. We point that at
 * a tiny helper (run by the daemon's own pinned node) which records the
 * fields we surface — context-window fill and cost — into a puddle-owned file
 * beside it, and prints a compact line so the terminal still shows a status.
 *
 * This is credential-free and documented: it reads no tokens, only the usage
 * numbers Claude Code already computes. The subscription rate-limit view
 * (`/usage`) is NOT in this payload (verified against 2.1.209) and lives
 * behind the separate opt-in path.
 *
 * Payload fields consumed (verified against Claude Code 2.1.209):
 *   context_window.used_percentage  — 0..100 or null before the first turn
 *   cost.total_cost_usd             — ~0 for subscription accounts (unmetered)
 *   model.display_name
 */
const STATUS_FILE = 'puddle-status.json';
const HELPER_FILE = 'puddle-statusline.mjs';

const HELPER_SOURCE = `import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const out = fileURLToPath(new URL('./${STATUS_FILE}', import.meta.url));
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let line = '';
  try {
    const j = JSON.parse(raw);
    const ctx = j.context_window?.used_percentage ?? null;
    const snapshot = {
      captured_at: new Date().toISOString(),
      context_used_percentage: typeof ctx === 'number' ? ctx : null,
      total_cost_usd: j.cost?.total_cost_usd ?? null,
      model: j.model?.display_name ?? null,
    };
    writeFileSync(out, JSON.stringify(snapshot));
    line =
      (snapshot.model ?? '') +
      (snapshot.context_used_percentage != null
        ? \`  ctx \${Math.round(snapshot.context_used_percentage)}%\`
        : '');
  } catch {
    line = '';
  }
  process.stdout.write(line);
});
`;

export interface ClaudeLiveUsage {
  captured_at: string;
  context_used_percentage: number | null;
  total_cost_usd: number | null;
  model: string | null;
}

/**
 * Installs the helper and points settings.json at it — but never clobbers a
 * status line the user (or an imported account) already configured. On
 * Windows Puddle's own line is rewritten on every install: its quoting
 * follows whether Claude will find Git Bash, which can change between boots.
 */
export function installStatusLine(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
  env: Environment = process.env,
): void {
  writeFileSync(join(configDir, HELPER_FILE), HELPER_SOURCE, { mode: 0o700 });
  const settingsFile = join(configDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
    } catch {
      // A corrupt settings file is replaced by one carrying only our line.
    }
  }
  const existing = settings['statusLine'];
  const ours = platform === 'win32' && runsHelper(existing, HELPER_FILE);
  if (existing !== undefined && !ours) return; // respect an existing one
  settings['statusLine'] = {
    type: 'command',
    command: claudeStatusLineCommand(
      join(configDir, HELPER_FILE),
      claudeStatusLineShell(platform, env),
    ),
  };
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/** The most recent captured live-usage snapshot, or null if none yet. */
export function readLiveUsage(configDir: string): ClaudeLiveUsage | null {
  const file = join(configDir, STATUS_FILE);
  if (!existsSync(file)) return null;
  try {
    const snap = JSON.parse(readFileSync(file, 'utf8')) as ClaudeLiveUsage;
    return typeof snap.captured_at === 'string' ? snap : null;
  } catch {
    return null;
  }
}
