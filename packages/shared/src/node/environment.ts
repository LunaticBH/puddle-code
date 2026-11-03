import { win32 } from 'node:path';

/**
 * Environment access that respects Windows' case-insensitive keys
 * (docs/windows.md, decision 10). A copied environment (`{ ...process.env }`)
 * is a plain object, so `env.PATH` may miss a `Path` key and assigning it
 * would create a duplicate that child processes resolve arbitrarily. On
 * POSIX every helper is plain, case-sensitive key access.
 */
export type Environment = Record<string, string | undefined>;

/**
 * The key under which `name` is stored, or `name` itself when absent. When a
 * Windows environment holds several spellings, this is the one
 * `child_process` passes on: Node keeps the first key in sorted order.
 */
export function envKey(
  env: Environment,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return name;
  const wanted = name.toUpperCase();
  const matches = Object.keys(env)
    .filter((key) => key.toUpperCase() === wanted)
    .sort();
  return matches[0] ?? name;
}

export function getEnv(
  env: Environment,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return env[envKey(env, name, platform)];
}

/** Sets `name`, keeping an existing key's spelling and dropping any other Windows spellings. */
export function setEnv(
  env: Environment,
  name: string,
  value: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const key = envKey(env, name, platform);
  if (platform === 'win32') removeSpellings(env, name, key);
  env[key] = value;
}

/** Removes `name` under every spelling on Windows. */
export function deleteEnv(
  env: Environment,
  name: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    delete env[name];
    return;
  }
  removeSpellings(env, name, null);
}

/** `;` on Windows, `:` elsewhere. */
export function pathListDelimiter(platform: NodeJS.Platform = process.platform): ';' | ':' {
  return platform === 'win32' ? ';' : ':';
}

/**
 * Puts `dir` first on PATH, removing its other occurrences (on Windows
 * compared case-insensitively, ignoring quotes and trailing separators).
 * Every other entry, empty ones included, keeps its place.
 */
export function prependPathEntry(
  env: Environment,
  dir: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const delimiter = pathListDelimiter(platform);
  const comparable =
    platform === 'win32'
      ? (entry: string) =>
          entry
            .replace(/^"(.*)"$/, '$1')
            .replace(/(?<=[^:\\/])[\\/]+$/, '')
            .toUpperCase()
      : (entry: string) => entry;
  const wanted = comparable(dir);
  const current = getEnv(env, 'PATH', platform);
  const rest =
    current === undefined || current === ''
      ? []
      : current.split(delimiter).filter((entry) => comparable(entry) !== wanted);
  setEnv(env, 'PATH', [dir, ...rest].join(delimiter), platform);
}

/**
 * `%SystemRoot%\System32\<file>` for a Windows system tool, so a planted
 * `taskkill.exe` in the working directory or on PATH is never run.
 */
export function system32Path(file: string, env: Environment = process.env): string {
  const root =
    getEnv(env, 'SystemRoot', 'win32') ?? getEnv(env, 'windir', 'win32') ?? 'C:\\Windows';
  return win32.join(root, 'System32', file);
}

function removeSpellings(env: Environment, name: string, keep: string | null): void {
  const wanted = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key !== keep && key.toUpperCase() === wanted) delete env[key];
  }
}
