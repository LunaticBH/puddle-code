import { homedir } from 'node:os';
import { join } from 'node:path';
import { initialisePrivateHome } from '@puddle/shared/node';

/**
 * The CLIENT machine's ~/.puddle — SSH control sockets and the tarball cache
 * live here. On the daemon's host the same directory holds the daemon state;
 * in local mode they are one and the same. Mirrors the daemon's PUDDLE_HOME
 * override (packages/daemon/src/paths.ts) so tests can relocate everything.
 */
export function clientHome(env: Record<string, string | undefined> = process.env): string {
  return env.PUDDLE_HOME ?? join(homedir(), '.puddle');
}

/**
 * Call before writing the first file into the client home. On Windows a
 * plain recursive mkdir would give a home outside the profile its drive
 * root's inherited ACL, open to every local account until the first check,
 * and whatever they put in it meanwhile would outlive that check
 * (docs/windows.md, decision 2): `initialisePrivateHome` creates the home
 * restricted instead, or checks an existing one. Elsewhere callers keep
 * their own mkdir.
 */
export function prepareClientHome(home = clientHome(), platform = process.platform): void {
  if (platform === 'win32') initialisePrivateHome(home);
}

/**
 * Paths on a daemon HOST, written as shell expressions so a remote sh
 * resolves them (`$HOME/.puddle` there) while a local run honours
 * PUDDLE_HOME — the same override the daemon and install.sh use.
 */
const HOST_HOME = '"${PUDDLE_HOME:-$HOME/.puddle}"';
export const hostPaths = {
  home: HOST_HOME,
  token: `${HOST_HOME}/token`,
  config: `${HOST_HOME}/config.json`,
  runtime: `${HOST_HOME}/runtime.json`,
  current: `${HOST_HOME}/bin/current`,
  cache: `${HOST_HOME}/cache`,
  logs: `${HOST_HOME}/logs`,
  supervisor: `${HOST_HOME}/supervisor`,
  pid: `${HOST_HOME}/puddled.pid`,
} as const;
