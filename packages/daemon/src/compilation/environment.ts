import { setEnv } from '@puddle/shared/node/platform';

/**
 * A copy of `base` with `overrides` applied. On POSIX this is exactly
 * `{ ...base, ...overrides }`. Windows keys are case-insensitive, and the
 * inherited environment usually spells PATH `Path`, so each override replaces
 * every spelling instead of adding a duplicate that a child might resolve
 * first (docs/windows.md decision 10).
 */
export function withEnvironment(
  overrides: Readonly<Record<string, string>>,
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [name, value] of Object.entries(overrides)) setEnv(env, name, value, platform);
  return env;
}
