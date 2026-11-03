import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  daemonConfigPatchSchema,
  daemonConfigSchema,
  type DaemonConfig,
  type DaemonConfigPatch,
} from '@puddle/shared';
import { getEnv, setEnv } from '@puddle/shared/node/platform';
import type { PuddlePaths } from './paths.js';

/**
 * The file-only format marker. loadConfig has always written defaults back, so
 * every pre-Phase-6 config.json literally says "port": 7433 — indistinguishable
 * from a user choice. Version 2 (the daemon moved to 7434 when the CLI took
 * over UI serving) migrates that one value once; version 3 (auto-resume
 * flipped ON by default, 2026-08-09) does the same for a pre-3 config's
 * "autoResume": false. In both cases the marker's presence stops the
 * migration re-firing, so a deliberate post-migration 7433 or false is
 * respected. zod strips the marker on parse — it never reaches the API.
 */
const CONFIG_VERSION = 3;

/**
 * The Windows agent search path: where Claude Code's native installer
 * (`~\.local\bin`), npm and pnpm global installs, Bun and Scoop put their
 * launchers. `;`-separated, like Windows' own PATH; `~` and `%VAR%` expand at
 * boot. Every entry is prepended, present or not, as on POSIX: a missing
 * directory costs nothing and finds an agent installed there after the next
 * daemon start.
 */
export const WINDOWS_AGENT_PATH = [
  '~\\.local\\bin',
  '%APPDATA%\\npm',
  '%LOCALAPPDATA%\\pnpm',
  '~\\.bun\\bin',
  '~\\scoop\\shims',
].join(';');

/** The shared schema's default is the POSIX search path. */
const POSIX_AGENT_PATH = daemonConfigSchema.parse({}).agentPath;

export function readConfig(
  paths: PuddlePaths,
  platform: NodeJS.Platform = process.platform,
): DaemonConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(paths.configFile, 'utf8')) as Record<string, unknown>;
  } catch {
    // Absent or unreadable → defaults; loadConfig persists them below.
  }
  if (raw.configVersion === undefined && raw.port === 7433) {
    delete raw.port; // falls through to the version-2 default (7434)
  }
  const version = typeof raw.configVersion === 'number' ? raw.configVersion : 0;
  if (version < 3 && raw.autoResume === false) {
    delete raw.autoResume; // falls through to the version-3 default (true)
  }
  // The schema cannot default per platform: on Windows an absent value, or the
  // POSIX default an older build wrote back, means the Windows search path.
  if (platform === 'win32' && (raw.agentPath === undefined || raw.agentPath === POSIX_AGENT_PATH)) {
    raw.agentPath = WINDOWS_AGENT_PATH;
  }
  return daemonConfigSchema.parse(raw);
}

function write(paths: PuddlePaths, cfg: DaemonConfig): void {
  writeFileSync(
    paths.configFile,
    JSON.stringify({ ...cfg, configVersion: CONFIG_VERSION }, null, 2) + '\n',
  );
}

/** Load config.json, filling defaults; writes the file so users can discover the knobs. */
export function loadConfig(paths: PuddlePaths): DaemonConfig {
  const cfg = readConfig(paths);
  write(paths, cfg);
  // A launchd/systemd-supervised daemon inherits a bare PATH; augment it here,
  // at the single load-at-boot site, so every child it later spawns can find
  // agent CLIs like `claude` (SPEC §5).
  applyAgentPath(cfg.agentPath);
  return cfg;
}

/**
 * Prepend the configured agent-search dirs to the daemon's PATH so it can spawn
 * agent CLIs (e.g. Claude Code's `~/.local/bin/claude`) even under a supervisor
 * with a bare PATH (launchd's `/usr/bin:/bin:/usr/sbin:/sbin`). Tilde-expanded,
 * de-duplicated, and applied to `process.env.PATH` so every child the daemon
 * spawns — PTYs and adapter exec calls, which both inherit `process.env` —
 * sees it. Called once at boot; a config change needs a daemon restart.
 */
export function applyAgentPath(
  agentPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (platform === 'win32') {
    applyWindowsAgentPath(agentPath, env);
    return;
  }
  const home = homedir();
  const extra = agentPath
    .split(':')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (d === '~' ? home : d.startsWith('~/') ? `${home}/${d.slice(2)}` : d));
  if (extra.length === 0) return;
  const current = (env.PATH ?? '').split(':').filter(Boolean);
  env.PATH = [...extra.filter((d) => !current.includes(d)), ...current].join(':');
}

/**
 * The Windows form: `;`-separated, `~\` or `~/` and `%VAR%` expanded (an entry
 * naming an unset variable is skipped), compared with the existing entries
 * case-insensitively and without trailing separators, and written back under
 * the environment's own `Path` spelling.
 */
function applyWindowsAgentPath(agentPath: string, env: NodeJS.ProcessEnv): void {
  const home = getEnv(env, 'USERPROFILE', 'win32') ?? homedir();
  const extra = agentPath
    .split(';')
    .map((d) => expandWindowsEntry(d.trim(), home, env))
    .filter((d): d is string => Boolean(d));
  if (extra.length === 0) return;
  const comparable = (entry: string) =>
    entry
      .replace(/^"(.*)"$/, '$1')
      .replace(/(?<=[^:\\/])[\\/]+$/, '')
      .toUpperCase();
  const current = (getEnv(env, 'PATH', 'win32') ?? '').split(';').filter(Boolean);
  const present = new Set(current.map(comparable));
  const fresh = [...new Set(extra)].filter((d) => !present.has(comparable(d)));
  setEnv(env, 'PATH', [...fresh, ...current].join(';'), 'win32');
}

function expandWindowsEntry(entry: string, home: string, env: NodeJS.ProcessEnv): string | null {
  const tilded =
    entry === '~' ? home : /^~[\\/]/.test(entry) ? `${home}\\${entry.slice(2)}` : entry;
  let unset = false;
  const expanded = tilded.replace(/%([^%]+)%/g, (_, name: string) => {
    const value = getEnv(env, name, 'win32');
    if (value === undefined || value === '') unset = true;
    return value ?? '';
  });
  return unset || expanded === '' ? null : expanded;
}

export function saveConfig(paths: PuddlePaths, patch: DaemonConfigPatch): DaemonConfig {
  const merged = daemonConfigSchema.parse({
    ...readConfig(paths),
    ...daemonConfigPatchSchema.parse(patch),
  });
  write(paths, merged);
  return merged;
}
