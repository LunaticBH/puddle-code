import { statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { deleteEnv, getEnv, setEnv, type Environment } from './environment.js';

export interface FindExecutableOptions {
  /** Search list in place of the environment's PATH. */
  path?: string;
  /** Windows extension list in place of the environment's PATHEXT. */
  pathext?: string;
  platform?: NodeJS.Platform;
  env?: Environment;
}

export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * The executable `name` would run, or null when there is none.
 *
 * POSIX keeps the daemon's long-standing agent lookup exactly: a name
 * containing `/` is checked as given; otherwise the first regular file with
 * any execute bit across PATH (split on `:`, empty entries skipped, symlinks
 * followed), returned as `join(dir, name)`.
 *
 * Windows has no execute bit, so PATHEXT decides: a name that already ends in
 * a PATHEXT extension is tried as given, any other name with each extension in
 * turn (appended in lower case). Extensions compare case-insensitively. PATH is
 * split on `;`, entries lose surrounding quotes and empty ones are skipped.
 * Unlike cmd.exe, the working directory is never searched implicitly, and
 * neither is a relative entry such as `.`: it would name whichever directory
 * the process happens to run in. A bare name therefore only ever resolves to
 * an absolute path. A name with a separator or a drive is checked directly,
 * with the same completion.
 *
 * `platform` selects the lookup rules; candidates are always joined with the
 * native `path`, since they name files on this machine.
 */
export function findExecutable(name: string, opts: FindExecutableOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform !== 'win32') {
    if (name.includes('/')) return isPosixExecutable(name) ? name : null;
    for (const dir of (opts.path ?? env.PATH ?? '').split(':')) {
      if (!dir) continue;
      const candidate = join(dir, name);
      if (isPosixExecutable(candidate)) return candidate;
    }
    return null;
  }
  if (name === '') return null;
  const extensions = windowsExtensions(opts.pathext ?? getEnv(env, 'PATHEXT', 'win32'));
  const candidates = hasExtension(name, extensions)
    ? [name]
    : extensions.map((extension) => name + extension.toLowerCase());
  if (/[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) {
    return candidates.find(isFile) ?? null;
  }
  for (const entry of (opts.path ?? getEnv(env, 'PATH', 'win32') ?? '').split(';')) {
    const dir = entry.replace(/^"(.*)"$/, '$1');
    if (!isFullyQualified(dir)) continue;
    for (const candidate of candidates) {
      const path = join(dir, candidate);
      if (isFile(path)) return path;
    }
  }
  return null;
}

const NO_CWD_SEARCH = 'NoDefaultCurrentDirectoryInExePath';

/**
 * The value Puddle gives `NoDefaultCurrentDirectoryInExePath`. Windows only
 * asks whether the variable exists, so any value turns the search off; this
 * one tells Puddle's setting from the user's in every process that inherits
 * it, such as a daemon the CLI or the desktop app started.
 */
const PUDDLE_NO_CWD_SEARCH = 'puddle';

/**
 * Turns off Windows' search of the working directory for a bare program name.
 * libuv (every Node spawn), cmd.exe and CreateProcess all look there before
 * PATH unless `NoDefaultCurrentDirectoryInExePath` is set, so a repository
 * that tracks `git.exe` would run as the user the moment a child starts in
 * it. Puddle resolves executables on PATH itself; this is the safety net for
 * a name that still reaches spawn unresolved, set once at process start-up.
 * libuv reads it from the spawning process's own environment, so programmes
 * the user runs drop it again with `restoreCurrentDirectorySearch`. A value
 * already present is kept: any value disables the search. POSIX never
 * searches the working directory, so it is left untouched.
 */
export function disableCurrentDirectorySearch(
  env: Environment = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32' || getEnv(env, NO_CWD_SEARCH, platform) !== undefined) return;
  setEnv(env, NO_CWD_SEARCH, PUDDLE_NO_CWD_SEARCH, platform);
}

/**
 * Takes `disableCurrentDirectorySearch`'s setting back out of `env`, the
 * environment of a programme the user runs or works in: a terminal shell, an
 * agent, a code run, a notebook kernel. There cmd.exe and batch files find
 * `gradlew`, `make.bat` or a sibling tool in the current directory, as in any
 * other console. The daemon's own spawns stay protected, since libuv consults
 * the daemon's environment, not the child's. A value the user set is kept.
 * POSIX is left untouched.
 */
export function restoreCurrentDirectorySearch(
  env: Environment,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') return;
  if (getEnv(env, NO_CWD_SEARCH, platform) === PUDDLE_NO_CWD_SEARCH) {
    deleteEnv(env, NO_CWD_SEARCH, platform);
  }
}

/**
 * A PATH entry that names one directory wherever the process runs: absolute
 * and, on a Windows host, with a drive or UNC prefix (`\tools` would follow
 * the current drive, and libuv resolves it against the child's working
 * directory instead).
 */
function isFullyQualified(dir: string): boolean {
  if (dir === '' || !isAbsolute(dir)) return false;
  return sep === '/' || /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(dir);
}

/** PATHEXT as a list of `.ext` entries; the Windows default when unset or empty. */
export function windowsExtensions(pathext: string | undefined): string[] {
  const entries = (pathext ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('.') && entry.length > 1);
  return entries.length > 0 ? entries : DEFAULT_PATHEXT.split(';');
}

function hasExtension(name: string, extensions: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension.toLowerCase()));
}

function isPosixExecutable(path: string): boolean {
  try {
    const st = statSync(path); // follows symlinks: most agent CLIs install as one
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false; // missing, or an unreadable parent directory
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
