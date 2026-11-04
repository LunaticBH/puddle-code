import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import {
  DEFAULT_PATHEXT,
  findExecutable,
  getEnv,
  pathListDelimiter,
} from '@puddle/shared/node/platform';
import { LATEX_TOOLS, type LatexToolchain } from './toolchain.js';

/** Re-check occasionally so installing TeX does not require a daemon restart. */
const CACHE_TTL_MS = 30_000;

interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
}

let cached: { key: string; at: number; toolchain: LatexToolchain } | null = null;

/** Drop process-wide discovery state (tests and future live PATH changes). */
export function clearLatexDiscoveryCache(): void {
  cached = null;
}

/**
 * Locate a broad TeX installation without invoking a shell. PATH remains
 * authoritative, followed by well-known TeX Live, MacTeX, TinyTeX and MiKTeX
 * roots: Unix ones on macOS and Linux (including WSL), and the default
 * per-user and machine-wide install directories on Windows.
 */
export function discoverLatexToolchain(options: DiscoveryOptions = {}): LatexToolchain {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const now = (options.now ?? Date.now)();
  const path = getEnv(env, 'PATH', platform);
  const key = `${platform}\0${home}\0${path ?? ''}\0${getEnv(env, 'TEXBIN', platform) ?? ''}`;
  if (cached && cached.key === key && now - cached.at < CACHE_TTL_MS) return cached.toolchain;

  const dirs =
    platform === 'win32'
      ? windowsCandidateDirectories(env, home)
      : candidateDirectories(env, home, platform);
  const paths: LatexToolchain['paths'] = {};
  for (const tool of LATEX_TOOLS) {
    const found = platform === 'win32' ? findWindowsTool(tool, dirs) : findPosixTool(tool, dirs);
    if (found) paths[tool] = found;
  }
  if (platform === 'win32' && paths.latexmk && !latexmkHasPerl(paths.latexmk, dirs)) {
    delete paths.latexmk;
  }
  const toolchain = { paths, searchPath: dirs.join(pathListDelimiter(platform)) };
  cached = { key, at: now, toolchain };
  return toolchain;
}

function findPosixTool(tool: string, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    const candidate = join(dir, tool);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** Windows has no execute bit: PATHEXT completes the name (`pdflatex.exe`). */
function findWindowsTool(tool: string, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    const found = findExecutable(tool, { path: dir, pathext: DEFAULT_PATHEXT, platform: 'win32' });
    if (found) return found;
  }
  return null;
}

function candidateDirectories(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): string[] {
  const dirs = new Set<string>();
  for (const dir of (env.PATH ?? '').split(pathListDelimiter(platform))) if (dir) dirs.add(dir);
  for (const dir of [env.TEXBIN, env.MIKTEX_HOME, env.TEXLIVE_HOME]) if (dir) dirs.add(dir);

  if (platform === 'darwin') {
    dirs.add('/Library/TeX/texbin');
    dirs.add('/Applications/MiKTeX Console.app/Contents/bin');
    addArchitectureDirs(dirs, join(home, 'Library', 'TinyTeX', 'bin'), platform);
    addArchitectureDirs(dirs, join(home, '.TinyTeX', 'bin'), platform);
  } else {
    // Distribution packages normally use these even when a supervisor gives
    // puddled a deliberately short PATH.
    dirs.add('/usr/bin');
    dirs.add('/usr/local/bin');
    addArchitectureDirs(dirs, join(home, '.TinyTeX', 'bin'), platform);
  }

  addVersionedTeXLiveDirs(dirs, '/usr/local/texlive', platform);
  addVersionedTeXLiveDirs(dirs, join(home, 'texlive'), platform);
  for (const root of [
    join(home, '.miktex', 'texmfs', 'install', 'miktex', 'bin'),
    '/usr/local/share/miktex-texmf/miktex/bin',
  ]) {
    dirs.add(root);
    addArchitectureDirs(dirs, root, platform);
  }
  return [...dirs];
}

/**
 * Windows: PATH (unquoted; relative and unexpanded `%VAR%` entries dropped),
 * the TeX variables, then MiKTeX per user and for all users, TeX Live in the
 * user profile and TinyTeX (whose `bin\windows`, `win32` or `win64`
 * architecture directory is found by listing), and Tectonic from cargo or
 * scoop. Folders any local account may create at the system drive's root are
 * never searched, since another user could plant a TeX engine or the Perl
 * that MiKTeX's latexmk runs on there: TeX Live's default `C:\texlive` and
 * Strawberry Perl are found through PATH, where their installers put them.
 */
function windowsCandidateDirectories(env: NodeJS.ProcessEnv, home: string): string[] {
  const variable = (name: string) => getEnv(env, name, 'win32');
  const dirs = new Set<string>();
  const add = (dir: string | undefined) => {
    if (dir && isSearchableDirectory(dir)) dirs.add(dir);
  };
  for (const entry of (variable('PATH') ?? '').split(';')) add(entry.replace(/^"(.*)"$/, '$1'));
  for (const name of ['TEXBIN', 'MIKTEX_HOME', 'TEXLIVE_HOME']) add(variable(name));

  const localAppData = variable('LOCALAPPDATA');
  const programFiles = variable('ProgramFiles');
  if (localAppData) add(join(localAppData, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'));
  if (programFiles) {
    add(join(programFiles, 'MiKTeX', 'miktex', 'bin', 'x64'));
    add(join(programFiles, 'MiKTeX 2.9', 'miktex', 'bin', 'x64'));
  }
  addVersionedTeXLiveDirs(dirs, join(home, 'texlive'), 'win32');
  const appData = variable('APPDATA');
  if (appData) addArchitectureDirs(dirs, join(appData, 'TinyTeX', 'bin'), 'win32');
  add(join(home, '.cargo', 'bin'));
  add(join(home, 'scoop', 'shims'));
  return [...dirs];
}

/**
 * latexmk is a Perl script behind an `.exe` wrapper. TeX Live's wrapper uses
 * the Perl TeX Live bundles (`<root>\tlpkg\tlperl`, beside
 * `<root>\bin\<arch>`); MiKTeX's needs a separately installed Perl and fails
 * every build without one, while its engines still work. Only files are
 * examined: no process is started.
 */
function latexmkHasPerl(latexmk: string, dirs: readonly string[]): boolean {
  const root = dirname(dirname(dirname(latexmk)));
  if (isFile(join(root, 'tlpkg', 'tlperl', 'bin', 'perl.exe'))) return true;
  return findWindowsTool('perl', dirs) !== null;
}

/** Add immediate children such as `universal-darwin` or `x86_64-linux`. */
function addArchitectureDirs(dirs: Set<string>, binRoot: string, platform: NodeJS.Platform): void {
  dirs.add(binRoot);
  for (const entry of safeDirectories(binRoot)) {
    if (entry.includes('darwin') && platform !== 'darwin') continue;
    if (entry.includes('linux') && platform !== 'linux') continue;
    dirs.add(join(binRoot, entry));
  }
}

/** Add `<year>/bin/<architecture>` without an unbounded filesystem walk. */
function addVersionedTeXLiveDirs(dirs: Set<string>, root: string, platform: NodeJS.Platform): void {
  for (const version of safeDirectories(root)) {
    const bin = join(root, version, 'bin');
    addArchitectureDirs(dirs, bin, platform);
  }
}

function safeDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * An absolute directory on this machine. On a Windows host that means a
 * drive or UNC path: `\texbin` would resolve against the current drive.
 */
function isSearchableDirectory(path: string): boolean {
  if (path.includes('%') || !isAbsolute(path)) return false;
  return sep === '/' || /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(path);
}
