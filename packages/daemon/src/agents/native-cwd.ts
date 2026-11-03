import { sameHostPath } from '../host-path.js';

/**
 * Whether a working directory an agent recorded in its own store names
 * `worktreePath`. POSIX keeps exact string identity. On Windows the agents
 * spell one directory differently: Claude Code records `C:\Users\…`, Gemini
 * CLI lower-cases its projects.json keys, Git prints `C:/…`, and Rust's
 * `canonicalize` adds a `\\?\` prefix. Windows therefore compares without
 * that prefix, separator- and case-insensitively (docs/windows.md, decision 11).
 */
export function sameNativeCwd(
  recorded: string,
  worktreePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return recorded === worktreePath;
  return sameHostPath(
    withoutVerbatimPrefix(recorded),
    withoutVerbatimPrefix(worktreePath),
    platform,
  );
}

/** `\\?\C:\x` → `C:\x` and `\\?\UNC\server\share` → `\\server\share`. */
function withoutVerbatimPrefix(path: string): string {
  return path.replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, '\\\\').replace(/^[\\/]{2}\?[\\/]/, '');
}
