import { findExecutable } from '@puddle/shared/node/platform';
import { ApiError } from '../http/errors.js';
import type { AgentAdapter } from './adapter.js';

/**
 * Agent-binary availability (SPEC §5).
 *
 * `AgentAdapter.binary` is resolved on the daemon's PATH, which `applyAgentPath`
 * (config.ts) has already extended with the configured agent-search dirs. Nothing
 * used to verify it existed, and node-pty does not fail loudly when it does not:
 * on macOS its spawn-helper `execvp`s and returns 1, so `pty.spawn` succeeds, the
 * child dies silently with no output, and the user sees a login terminal flash
 * open and vanish. Worse, `checkLoggedIn` cannot tell "no binary" from "logged
 * out", so a missing CLI used to surface as `account_logged_out` AND clear the
 * account's stored logged-in flag. Hence: check first, fail with a precise error.
 */

/** How long a lookup is trusted. Short enough that installing an agent mid-session
 * un-sticks the UI without a daemon restart, long enough that the per-request stat
 * sweep across every adapter costs nothing in the steady state. */
const TTL_MS = 30_000;

const cache = new Map<string, { at: number; path: string | null }>();

/**
 * Absolute path of `name` on the daemon's PATH, or null when it is not
 * installed. Results (including misses) are cached for {@link TTL_MS}. On
 * Windows the lookup honours PATHEXT, so `claude` finds `claude.exe` and an
 * npm-installed `codex` finds `codex.cmd`.
 */
export function resolveBinary(name: string): string | null {
  const hit = cache.get(name);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.path;
  const path = findExecutable(name);
  cache.set(name, { at: now, path });
  return path;
}

/** Whether the adapter's executable resolves on the daemon's PATH. */
export function isBinaryAvailable(adapter: AgentAdapter): boolean {
  return resolveBinary(adapter.binary) !== null;
}

/**
 * Guards every path that spawns an agent — login, session create/resume,
 * migration, hand-off. MUST run before `checkLoggedIn`, which would otherwise
 * mistake an absent CLI for an expired credential and clear `logged_in`.
 */
export function assertBinaryAvailable(adapter: AgentAdapter): void {
  if (isBinaryAvailable(adapter)) return;
  throw new ApiError(
    424,
    'agent_not_installed',
    `${adapter.displayName} is not installed — no '${adapter.binary}' executable on the daemon's PATH. ` +
      'Install it, or add its directory to the agent search path in Settings → Sessions.',
  );
}

/** Drops every cached lookup — for tests, and for a future live `agentPath` edit. */
export function clearBinaryCache(): void {
  cache.clear();
}
