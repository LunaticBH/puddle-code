import { homedir } from 'node:os';
import { join, win32 } from 'node:path';

/**
 * Expands a leading ~ against the daemon host's home directory. Only the
 * daemon can do this — the browser has no idea where home is on the host.
 * A trailing slash survives expansion: `join` normalises it away, but for
 * directory autocomplete it is load-bearing — `~/` must list home's contents,
 * not complete home's basename inside its parent.
 *
 * Windows also accepts `~\`; a trailing separator of either kind survives as `\`.
 */
export function expandTilde(
  path: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === 'win32') return expandWindowsTilde(path, home);
  if (path === '~') return home;
  if (path.startsWith('~/')) {
    const expanded = join(home, path.slice(2));
    return path.endsWith('/') && !expanded.endsWith('/') ? `${expanded}/` : expanded;
  }
  return path;
}

function expandWindowsTilde(path: string, home: string): string {
  if (path === '~') return home;
  if (!/^~[\\/]/.test(path)) return path;
  const expanded = win32.join(home, path.slice(2));
  return /[\\/]$/.test(path) && !expanded.endsWith('\\') ? `${expanded}\\` : expanded;
}
