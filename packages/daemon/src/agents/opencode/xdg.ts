import { join } from 'node:path';

/** Subdirectories of the account config dir that back opencode's XDG roots. */
export const CONFIG_HOME = 'config';
export const DATA_HOME = 'data';
export const CACHE_HOME = 'cache';
export const STATE_HOME = 'state';

/** The four XDG roots, all under the account's puddle-owned config dir. */
export function xdgEnv(configDir: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(configDir, CONFIG_HOME),
    XDG_DATA_HOME: join(configDir, DATA_HOME),
    XDG_CACHE_HOME: join(configDir, CACHE_HOME),
    XDG_STATE_HOME: join(configDir, STATE_HOME),
  };
}
