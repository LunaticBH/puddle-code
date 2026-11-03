import { execAgent } from './agent-process.js';

/**
 * How long a failed probe is trusted on Windows. A cold Node or Bun start
 * under Defender scanning can miss the probe's bound once, which must not
 * disable an agent's hooks and headless mode for the daemon's lifetime.
 * POSIX keeps every result for the daemon's lifetime.
 */
const WINDOWS_FAILURE_TTL_MS = 60_000;

const checks = new Map<string, { result: Promise<boolean>; failedAt: number | null }>();

/** Cached, bounded CLI-version capability probe used before hook launches. */
export function lifecycleVersionAtLeast(
  binary: string,
  args: string[],
  minimum: readonly [number, number, number],
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const key = `${binary}\0${args.join('\0')}\0${minimum.join('.')}`;
  const active = checks.get(key);
  if (
    active &&
    (active.failedAt === null || Date.now() - active.failedAt < WINDOWS_FAILURE_TTL_MS)
  ) {
    return active.result;
  }
  const entry: { result: Promise<boolean>; failedAt: number | null } = {
    result: Promise.resolve(false),
    failedAt: null,
  };
  entry.result = execAgent(
    binary,
    args,
    { timeout: platform === 'win32' ? 10_000 : 3_000, maxBuffer: 64 * 1024 },
    platform,
  )
    .then(({ stdout, stderr }) => {
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(`${String(stdout)}\n${String(stderr)}`);
      if (!match) return false;
      const found = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
      for (let index = 0; index < minimum.length; index++) {
        if (found[index]! > minimum[index]!) return true;
        if (found[index]! < minimum[index]!) return false;
      }
      return true;
    })
    .catch(() => {
      if (platform === 'win32') entry.failedAt = Date.now();
      return false;
    });
  checks.set(key, entry);
  return entry.result;
}
