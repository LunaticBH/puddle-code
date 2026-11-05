import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, sep, win32 } from 'node:path';
import {
  DEFAULT_PATHEXT,
  findExecutable,
  getEnv,
  system32Path,
} from '@puddle/shared/node/platform';
import { isPowerShellAppAlias } from '../pty/shell.js';

const cache = new Map<string, { at: number; path: string | null }>();
const listings = new Map<string, { at: number; names: string[] }>();
const CACHE_TTL_MS = 30_000;

/** PATH first, then bounded conventional user/package-manager installations. */
export function codeSearchDirectories(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') return windowsSearchDirectories(env, home);
  return [
    ...new Set(
      [
        ...(env.PATH ?? '').split(delimiter),
        ...(env.VIRTUAL_ENV ? [join(env.VIRTUAL_ENV, 'bin')] : []),
        join(home, '.local', 'bin'),
        join(home, '.cargo', 'bin'),
        join(home, '.bun', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ].filter((path) => isAbsolute(path)),
    ),
  ];
}

export function findCodeExecutable(
  names: readonly string[],
  directories = codeSearchDirectories(),
  platform: NodeJS.Platform = process.platform,
  /** Test seam: whether a path is the Store PowerShell's App Execution Alias. */
  isPowerShellAlias: (path: string) => boolean = isPowerShellAppAlias,
): string | null {
  const cached = isPowerShellAlias === isPowerShellAppAlias;
  const key = JSON.stringify([platform, names, directories]);
  const previous = cached ? cache.get(key) : undefined;
  if (previous && Date.now() - previous.at < CACHE_TTL_MS) return previous.path;
  let found: string | null = null;
  for (const name of names) {
    found =
      platform === 'win32'
        ? (findWindowsExecutable(name, directories) ??
          findPowerShellAlias(name, directories, isPowerShellAlias))
        : findPosixExecutable(name, directories);
    if (found) break;
  }
  if (!cached) return found;
  if (cache.size >= 128) cache.clear();
  cache.set(key, { at: Date.now(), path: found });
  return found;
}

function findPosixExecutable(name: string, directories: readonly string[]): string | null {
  for (const directory of directories) {
    const candidate = join(directory, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // An absent or non-executable candidate cannot run this recipe.
    }
  }
  return null;
}

/**
 * Windows has no execute bit: a bare name is completed with the extensions
 * that can be started without a shell or through `resolveSpawn` (`.com`,
 * `.exe`, and npm-style `.bat`/`.cmd` shims), never accepted extensionless.
 * npm and pnpm also install extensionless sh scripts beside their `.cmd`
 * shims, which Windows cannot run. App Execution Aliases cannot be stat'ed,
 * so the Microsoft Store's python.exe redirector stubs are never chosen.
 */
function findWindowsExecutable(name: string, directories: readonly string[]): string | null {
  for (const directory of directories) {
    const found = findExecutable(name, {
      path: directory,
      pathext: DEFAULT_PATHEXT,
      platform: 'win32',
    });
    if (found) return found;
  }
  return null;
}

/**
 * The one App Execution Alias that counts: the Microsoft Store's PowerShell
 * 7 (`pwsh`), when no installed pwsh.exe was found (pty/shell.ts).
 */
function findPowerShellAlias(
  name: string,
  directories: readonly string[],
  isAlias: (path: string) => boolean,
): string | null {
  if (name.toLowerCase() !== 'pwsh') return null;
  for (const directory of directories) {
    const candidate = join(directory, 'pwsh.exe');
    if (isAlias(candidate)) return candidate;
  }
  return null;
}

/**
 * Windows: PATH (quotes stripped; relative and unexpanded `%VAR%` entries
 * dropped, so nothing resolves against the daemon's working directory), the
 * active venv's `Scripts`, then the default locations of common installers
 * that only this user or an administrator can create: the user profile and
 * `%ProgramFiles%`, and last Windows PowerShell's folder under System32
 * (`.ps1` runs). Folders any local account may create, the system drive's
 * root and `%ProgramData%`, are never searched: another user could plant
 * `C:\Python399\python.exe` or `C:\msys64\ucrt64\bin\gcc.exe` before the
 * real installer runs. MSYS2, Strawberry Perl, RubyInstaller and Chocolatey
 * installs there are found through PATH instead, and python.org's all-user
 * installs through the py launcher. Versioned installations (`Python312`,
 * `R-4.4.1`) are found with one directory listing, never a recursive walk.
 */
function windowsSearchDirectories(env: NodeJS.ProcessEnv, home: string): string[] {
  const variable = (name: string) => getEnv(env, name, 'win32');
  const under = (root: string | undefined, ...parts: string[]) =>
    root ? [join(root, ...parts)] : [];
  const localAppData = variable('LOCALAPPDATA');
  const programFiles = variable('ProgramFiles');
  return [
    ...new Set(
      [
        ...(variable('PATH') ?? '').split(';').map((entry) => entry.replace(/^"(.*)"$/, '$1')),
        ...under(variable('VIRTUAL_ENV'), 'Scripts'),
        join(home, '.local', 'bin'),
        join(home, '.cargo', 'bin'),
        join(home, '.bun', 'bin'),
        join(home, 'scoop', 'shims'),
        ...under(variable('APPDATA'), 'npm'),
        ...under(localAppData, 'pnpm'),
        ...under(localAppData, 'Microsoft', 'WinGet', 'Links'),
        // App Execution Aliases: only the Store PowerShell's is ever chosen there.
        ...under(localAppData, 'Microsoft', 'WindowsApps'),
        ...under(localAppData, 'Programs', 'Python').flatMap((root) =>
          versioned(root, /^Python3\d*$/i, ['', 'Scripts']),
        ),
        ...under(programFiles, 'nodejs'),
        ...under(programFiles, 'Go', 'bin'),
        ...under(programFiles, 'LLVM', 'bin'),
        ...under(programFiles, 'R').flatMap((root) => versioned(root, /^R-/i, ['bin'])),
        // Windows PowerShell for `.ps1` runs when Path has lost it.
        system32Path(win32.join('WindowsPowerShell', 'v1.0'), env),
      ].filter(isSearchableDirectory),
    ),
  ];
}

/** `<root>\<child>\<suffix>` for each child of `root` whose name matches. */
function versioned(
  root: string | undefined,
  pattern: RegExp,
  suffixes: readonly string[],
): string[] {
  if (!root) return [];
  return childNames(root)
    .filter((name) => pattern.test(name))
    .sort()
    .reverse() // newest version first
    .flatMap((name) => suffixes.map((suffix) => join(root, name, suffix)));
}

/** Directory names under `root`, listed at most once per cache period. */
function childNames(root: string): string[] {
  const previous = listings.get(root);
  if (previous && Date.now() - previous.at < CACHE_TTL_MS) return previous.names;
  let names: string[] = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // Optional installation root.
  }
  if (listings.size >= 32) listings.clear();
  listings.set(root, { at: Date.now(), names });
  return names;
}

/**
 * An absolute directory on this machine. On a Windows host that means a
 * drive or UNC path: `\tools` would resolve against the current drive.
 */
function isSearchableDirectory(path: string): boolean {
  if (path === '' || path.includes('%') || !isAbsolute(path)) return false;
  return sep === '/' || /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(path);
}
