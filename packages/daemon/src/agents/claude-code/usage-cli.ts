import type { Account } from '@puddle/shared';
import { setEnv } from '@puddle/shared/node/platform';
import type { SubscriptionUsageWindow } from '../adapter.js';
import { execAgent } from '../agent-process.js';

/**
 * Subscription rate-limit usage — the "session / weekly" windows Claude
 * Code's `/usage` view shows — fetched by asking the CLI itself:
 * `claude -p /usage` prints them as plain text (verified against 2.1.209).
 * Credential-free: puddle reads no tokens; the CLI authenticates with the
 * account's own config dir exactly as an interactive session would.
 *
 * Gotcha (verified 2.1.209): an ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in
 * the environment takes auth precedence over the subscription login and the
 * windows are silently omitted — so those are scrubbed, along with the
 * CLAUDECODE / CLAUDE_CODE_* nested-session markers a development daemon may
 * have inherited.
 *
 * Every fetch spawns a claude process, so results are cached per account:
 * successes for 5 minutes, failures for 1 minute. Any failure — missing
 * binary, timeout, logged-out account, unrecognised output — yields `null`,
 * and the UI shows nothing rather than wrong numbers.
 */

const SUCCESS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 60_000;

/** `Current session: 43% used · resets Jul 14 at 6:49am (America/Los_Angeles)` */
const WINDOW_LINE = /^Current ([^:]+):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+))?$/;

/** Exported for tests. Returns null when no window line is present. */
export function parseUsageOutput(stdout: string): SubscriptionUsageWindow[] | null {
  const windows: SubscriptionUsageWindow[] = [];
  for (const line of stdout.split('\n')) {
    const match = WINDOW_LINE.exec(line.trim());
    if (!match) continue;
    const [, label, pct, resets] = match as unknown as [string, string, string, string?];
    windows.push({
      key: label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''),
      label,
      used_percentage: Number(pct),
      // The timezone parenthetical is dropped — "Jul 20 at 4am" reads fine.
      resets: resets?.replace(/\s*\([^)]*\)\s*$/, '').trim() || null,
    });
  }
  return windows.length > 0 ? windows : null;
}

interface CacheEntry {
  expiresAt: number;
  windows: SubscriptionUsageWindow[] | null;
}

const cache = new Map<number, CacheEntry>();
const inFlight = new Map<number, Promise<SubscriptionUsageWindow[] | null>>();

/** Exported for tests. Windows environment names are case-insensitive, so they match any spelling. */
export function scrubbedEnv(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  if (platform === 'win32') {
    for (const key of Object.keys(env)) {
      const name = key.toUpperCase();
      if (
        name === 'ANTHROPIC_API_KEY' ||
        name === 'ANTHROPIC_AUTH_TOKEN' ||
        name === 'CLAUDECODE' ||
        name.startsWith('CLAUDE_CODE_')
      ) {
        delete env[key];
      }
    }
    setEnv(env, 'CLAUDE_CONFIG_DIR', configDir, platform);
    return env;
  }
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  env['CLAUDE_CONFIG_DIR'] = configDir;
  return env;
}

export async function fetchSubscriptionUsage(
  account: Account,
): Promise<SubscriptionUsageWindow[] | null> {
  const cached = cache.get(account.id);
  if (cached && cached.expiresAt > Date.now()) return cached.windows;
  const pending = inFlight.get(account.id);
  if (pending) return pending;

  const fetch = (async () => {
    let windows: SubscriptionUsageWindow[] | null;
    try {
      const { stdout } = await execAgent('claude', ['-p', '/usage'], {
        env: scrubbedEnv(account.config_dir),
        timeout: 30_000,
      });
      windows = parseUsageOutput(stdout);
    } catch {
      windows = null; // no binary / timeout / non-zero exit → unavailable
    }
    cache.set(account.id, {
      expiresAt: Date.now() + (windows ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
      windows,
    });
    return windows;
  })();
  inFlight.set(account.id, fetch);
  try {
    return await fetch;
  } finally {
    inFlight.delete(account.id);
  }
}
