import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sameNativeCwd } from '../native-cwd.js';

/**
 * Codex's own session index — `$CODEX_HOME/state_<n>.sqlite`, a `threads` table
 * keyed by the same uuid as the rollout file.
 *
 * Verified against codex-cli 0.146.0 (2026-08-01), reading a real state_5:
 * - `name` is the session's own name — what `codex resume`/`archive` accept as
 *   an alternative to the uuid, and what a rename sets. Empty until named.
 * - `title` / `preview` / `first_user_message` all hold the FIRST USER MESSAGE
 *   verbatim and untruncated (8 KiB in one sampled row) — codex writes no short
 *   curated title the way Claude Code does, so this is a fallback to be cut
 *   down, not a display string.
 *
 * Read-only and best-effort. The filename carries a schema version, so a codex
 * upgrade can rename or reshape it out from under us; reads fail to a neutral
 * `null`/empty result and rollout scanning remains available for ref discovery.
 */

export interface CodexThread {
  id: string;
  cwd: string;
  createdAt: number | null;
  rolloutPath: string;
  title: string | null;
}

export interface CodexThreadIndex {
  /** False means the rollout compatibility path must be used. */
  available: boolean;
  threads: CodexThread[];
}

/** Newest `state_<n>.sqlite` under the config dir, or null. */
function stateDbPath(configDir: string): string | null {
  let best: { path: string; version: number } | null = null;
  let names: string[];
  try {
    names = readdirSync(configDir);
  } catch {
    return null;
  }
  for (const name of names) {
    const match = /^state_(\d+)\.sqlite$/.exec(name);
    if (match === null) continue;
    const version = Number(match[1]);
    if (best === null || version > best.version) best = { path: join(configDir, name), version };
  }
  return best?.path ?? null;
}

/**
 * Top-level thread rows, newest first. The state DB is written before a large
 * rollout's first JSONL record is necessarily readable, so it is the primary
 * source for launch-time id capture; rollout scanning remains the fallback.
 */
export function codexThreadIndex(
  configDir: string,
  cwd?: string,
  platform: NodeJS.Platform = process.platform,
): CodexThreadIndex {
  const path = stateDbPath(configDir);
  if (path === null || !existsSync(path)) return { available: false, threads: [] };
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const columns = new Set(
      (db.prepare('pragma table_info(threads)').all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    const createdMs = columns.has('created_at_ms')
      ? 'coalesce(created_at_ms, created_at * 1000)'
      : 'created_at * 1000';
    const threadSource = columns.has('thread_source') ? 'thread_source' : 'NULL';
    const name = columns.has('name') ? 'name' : 'NULL';
    const title = columns.has('title') ? 'title' : 'NULL';
    // SQL equality cannot match Windows spellings of one directory; filter below.
    const sqlCwd = platform === 'win32' ? undefined : cwd;
    const rows = db
      .prepare(
        `select id, cwd, ${createdMs} as created_ms, rollout_path,
                ${name} as name, ${title} as title,
                ${threadSource} as thread_source, source
         from threads
         ${sqlCwd === undefined ? '' : 'where cwd = ?'}
         order by created_ms desc, id desc`,
      )
      .all(...(sqlCwd === undefined ? [] : [sqlCwd])) as Array<{
      id: string;
      cwd: string;
      created_ms: number | null;
      rollout_path: string;
      name: string | null;
      title: string | null;
      thread_source: string | null;
      source: string;
    }>;
    return {
      available: true,
      threads: rows
        .filter((row) => row.thread_source !== 'subagent' && !row.source.includes('"subagent"'))
        .filter(
          (row) =>
            sqlCwd !== undefined || cwd === undefined || sameNativeCwd(row.cwd, cwd, platform),
        )
        .map((row) => ({
          id: row.id,
          cwd: row.cwd,
          createdAt: row.created_ms,
          rolloutPath: row.rollout_path,
          title: oneLine(row.name) ?? oneLine(row.title),
        })),
    };
  } catch {
    return { available: false, threads: [] };
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing useful to do */
    }
  }
}

/** Compatibility wrapper for callers that only need the rows. */
export function codexThreads(configDir: string, cwd?: string): CodexThread[] {
  return codexThreadIndex(configDir, cwd).threads;
}

/** Indexed ref lookup used by the activity badge; never scans rollout history. */
export function codexThread(configDir: string, ref: string): CodexThread | null {
  const path = stateDbPath(configDir);
  if (path === null || !existsSync(path)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const columns = new Set(
      (db.prepare('pragma table_info(threads)').all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    const createdMs = columns.has('created_at_ms')
      ? 'coalesce(created_at_ms, created_at * 1000)'
      : 'created_at * 1000';
    const threadSource = columns.has('thread_source') ? 'thread_source' : 'NULL';
    const name = columns.has('name') ? 'name' : 'NULL';
    const title = columns.has('title') ? 'title' : 'NULL';
    const row = db
      .prepare(
        `select id, cwd, ${createdMs} as created_ms, rollout_path,
                ${name} as name, ${title} as title,
                ${threadSource} as thread_source, source
         from threads where id = ?`,
      )
      .get(ref) as
      | {
          id: string;
          cwd: string;
          created_ms: number | null;
          rollout_path: string;
          name: string | null;
          title: string | null;
          thread_source: string | null;
          source: string;
        }
      | undefined;
    if (
      row === undefined ||
      row.thread_source === 'subagent' ||
      row.source.includes('"subagent"')
    ) {
      return null;
    }
    return {
      id: row.id,
      cwd: row.cwd,
      createdAt: row.created_ms,
      rolloutPath: row.rollout_path,
      title: oneLine(row.name) ?? oneLine(row.title),
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing useful to do */
    }
  }
}

/**
 * The display name codex would show for `ref`: its own session name when one is
 * set, else the opening user message cut to a single ≤80-char line. Null when
 * the thread is unknown or the index cannot be read.
 *
 * Opened and closed per call rather than held: the file is another process's
 * live database and its name is version-stamped, so keeping a handle across a
 * codex upgrade would pin a stale (or deleted) file. A single indexed lookup a
 * few times a minute costs nothing.
 */
export function threadTitle(configDir: string, ref: string): string | null {
  const path = stateDbPath(configDir);
  if (path === null || !existsSync(path)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const row = db.prepare('select name, title from threads where id = ?').get(ref) as
      { name?: string | null; title?: string | null } | undefined;
    if (row === undefined) return null;
    return oneLine(row.name) ?? oneLine(row.title);
  } catch {
    return null; // missing table, schema drift, locked, unreadable — all the same answer
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing useful to do */
    }
  }
}

/** Collapse to a single ≤80-char line, matching the claude-code adapter. */
function oneLine(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const norm = raw.trim().replace(/\s+/g, ' ').slice(0, 80);
  return norm === '' ? null : norm;
}
