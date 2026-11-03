import { hostPathStyle, toRootRelative } from '@puddle/shared';
import { isHostRoot } from './host-path';

/**
 * Compress the daemon home-directory prefix to `~` for display (SPEC §8) —
 * `home` comes from `GET /api/host`, so it is the DAEMON user's home whatever
 * the OS layout (`/home/<user>` on Linux, `/Users/<user>` on macOS,
 * `C:\Users\<user>` on Windows). Only a whole-segment prefix qualifies:
 * `/Users/alice-backup` is not inside `/Users/alice`. Pure and DOM-free —
 * unit-testable.
 */
export function tildify(path: string, home: string | undefined): string {
  if (!home) return path;
  if (hostPathStyle(home) === 'win32') return tildifyWindows(path, home);
  const root = home.endsWith('/') ? home.slice(0, -1) : home;
  if (root === '' || root === '/') return path;
  if (path === root) return '~';
  return path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path;
}

/**
 * A Windows home matches as Windows paths do (any case, either separator) and
 * displays in the host's own syntax: `C:\Users\alice\repo` → `~\repo`
 * (docs/windows.md, decision 11). A drive root is never compressed, like `/`.
 */
function tildifyWindows(path: string, home: string): string {
  if (isHostRoot(home)) return path;
  const relative = toRootRelative(home, path);
  if (relative === null) return path;
  return relative === '' ? '~' : `~\\${relative.replaceAll('/', '\\')}`;
}
