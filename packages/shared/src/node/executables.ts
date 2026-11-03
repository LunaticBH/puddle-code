import { statSync } from 'node:fs';
import { join } from 'node:path';
import { getEnv, type Environment } from './environment.js';

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
 * Unlike cmd.exe, the working directory is never searched implicitly. A name
 * with a separator or a drive is checked directly, with the same completion.
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
    if (!dir) continue;
    for (const candidate of candidates) {
      const path = join(dir, candidate);
      if (isFile(path)) return path;
    }
  }
  return null;
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
