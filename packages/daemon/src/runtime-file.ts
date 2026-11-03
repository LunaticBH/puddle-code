import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { renameWithRetrySync } from '@puddle/shared/node/platform';
import type { PuddlePaths } from './paths.js';

/**
 * The live-port record (~/.puddle/runtime.json). config.json holds the daemon's
 * PREFERRED port; this file holds where it ACTUALLY bound — which differs only
 * when the preferred port was busy and the daemon fell back to a free one
 * (daemon.ts). Clients read it to find the daemon (packages/cli readDaemonPort),
 * always revalidating by token, so a stale file only triggers a restart, never a
 * mis-wire. Host-local state, not wire protocol — no PROTOCOL_VERSION bump.
 */
export interface RuntimeInfo {
  /** The port the daemon is actually listening on. */
  port: number;
  /** The daemon's process id — for diagnostics and staleness checks. */
  pid: number;
}

/**
 * Record the live port atomically (temp + rename) so a reader never sees a
 * half-write. Windows retries the replacement while a reader holds the file.
 */
export function writeRuntime(paths: PuddlePaths, info: RuntimeInfo): void {
  const tmp = `${paths.runtimeFile}.${info.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
  renameWithRetrySync(tmp, paths.runtimeFile);
}

/** The recorded live port, or null when the file is absent or malformed. */
export function readRuntime(paths: PuddlePaths): RuntimeInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(paths.runtimeFile, 'utf8')) as Partial<RuntimeInfo>;
    if (typeof parsed.port === 'number' && typeof parsed.pid === 'number') {
      return { port: parsed.port, pid: parsed.pid };
    }
  } catch {
    // absent or unreadable → no runtime info
  }
  return null;
}

/**
 * Remove the record on clean shutdown, so its presence means "the daemon
 * believes it is up". A crash leaves it stale — readers probe-validate, so
 * that is safe.
 */
export function clearRuntime(paths: PuddlePaths): void {
  rmSync(paths.runtimeFile, { force: true });
}
