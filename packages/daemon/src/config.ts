import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  daemonConfigPatchSchema,
  daemonConfigSchema,
  type DaemonConfig,
  type DaemonConfigPatch,
} from '@puddle/shared';
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

export function readConfig(paths: PuddlePaths): DaemonConfig {
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
export function applyAgentPath(agentPath: string): void {
  const home = homedir();
  const extra = agentPath
    .split(':')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (d === '~' ? home : d.startsWith('~/') ? `${home}/${d.slice(2)}` : d));
  if (extra.length === 0) return;
  const current = (process.env.PATH ?? '').split(':').filter(Boolean);
  process.env.PATH = [...extra.filter((d) => !current.includes(d)), ...current].join(':');
}

export function saveConfig(paths: PuddlePaths, patch: DaemonConfigPatch): DaemonConfig {
  const merged = daemonConfigSchema.parse({
    ...readConfig(paths),
    ...daemonConfigPatchSchema.parse(patch),
  });
  write(paths, merged);
  return merged;
}
