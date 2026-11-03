import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, sep } from 'node:path';
import { DEFAULT_PATHEXT, findExecutable, getEnv } from '@puddle/shared/node/platform';

const cache = new Map<string, { at: number; path: string | null }>();
const listings = new Map<string, { at: number; names: string[] }>();
const CACHE_TTL_MS = 30_000;

/**
 * System32's bash.exe (and a WindowsApps alias of it) is the WSL launcher: it
 * would run a `.sh` file inside a Linux distribution that cannot open its
 * Windows path, so the Shell recipe only accepts other installations such as
 * Git for Windows.
 */
const WSL_LAUNCHERS = new Set(['bash']);
const WSL_LAUNCHER_DIRECTORY = /[\\/](?:System32|WindowsApps)[\\/]*$/i;

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
): string | null {
  const key = JSON.stringify([platform, names, directories]);
  const previous = cache.get(key);
  if (previous && Date.now() - previous.at < CACHE_TTL_MS) return previous.path;
  let found: string | null = null;
  for (const name of names) {
    found =
      platform === 'win32'
        ? findWindowsExecutable(name, directories)
        : findPosixExecutable(name, directories);
    if (found) break;
  }
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
  const searched = WSL_LAUNCHERS.has(name.toLowerCase())
    ? directories.filter((directory) => !WSL_LAUNCHER_DIRECTORY.test(directory))
    : directories;
  for (const directory of searched) {
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
 * Windows: PATH (quotes stripped; relative and unexpanded `%VAR%` entries
 * dropped, so nothing resolves against the daemon's working directory), the
 * active venv's `Scripts`, then the default locations of common installers.
 * Versioned installations (`Python312`, `R-4.4.1`, `Ruby33-x64`) are found
 * with one directory listing, never a recursive walk.
 */
function windowsSearchDirectories(env: NodeJS.ProcessEnv, home: string): string[] {
  const variable = (name: string) => getEnv(env, name, 'win32');
  const under = (root: string | undefined, ...parts: string[]) =>
    root ? [join(root, ...parts)] : [];
  const localAppData = variable('LOCALAPPDATA');
  const programFiles = variable('ProgramFiles');
  const systemDrive = variable('SystemDrive');
  const driveRoot = systemDrive ? `${systemDrive.replace(/[\\/]+$/, '')}${sep}` : undefined;
  // python.org installs per user and, for older installers, at the drive root.
  const pythons = [...under(localAppData, 'Programs', 'Python'), ...(driveRoot ? [driveRoot] : [])];
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
        ...under(variable('ProgramData'), 'chocolatey', 'bin'),
        ...pythons.flatMap((root) => versioned(root, /^Python3\d*$/i, ['', 'Scripts'])),
        ...under(programFiles, 'nodejs'),
        ...under(programFiles, 'Go', 'bin'),
        ...under(programFiles, 'LLVM', 'bin'),
        ...under(programFiles, 'Git', 'bin'),
        ...under(programFiles, 'R').flatMap((root) => versioned(root, /^R-/i, ['bin'])),
        ...under(driveRoot, 'msys64', 'ucrt64', 'bin'),
        ...under(driveRoot, 'Strawberry', 'perl', 'bin'),
        ...versioned(driveRoot, /^Ruby/i, ['bin']),
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
