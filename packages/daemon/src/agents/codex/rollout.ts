import { createReadStream } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { sameNativeCwd } from '../native-cwd.js';

/**
 * Reading Codex's rollout files — the JSONL transcripts it writes per session.
 *
 * Layout verified against codex-cli 0.146.0 (2026-07-31):
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl`, where line 1
 * is a `session_meta` record carrying the session `id` and the `cwd` it ran in.
 *
 * Discovery is deliberately asynchronous and incremental. Imported/eval
 * accounts may contain thousands of multi-megabyte rollouts; synchronous full
 * reads here used to stop every daemon API and PTY while a new Codex session
 * was finding its native ref. Only the bounded header is read, and unchanged
 * files reuse their parsed metadata across polls.
 */

export interface RolloutMeta {
  id: string;
  cwd: string;
  createdAt: number | null;
  parentThreadId: string | null;
}

interface RolloutEntry {
  path: string;
  meta: RolloutMeta;
}

interface RolloutLine {
  type?: string;
  payload?: {
    type?: string;
    id?: string;
    cwd?: string;
    timestamp?: string;
    parent_thread_id?: string;
    message?: string;
    text?: string;
  };
}

const HEADER_BYTES = 64 * 1024;
const READ_CONCURRENCY = 32;
const metadataCache = new Map<string, Map<string, RolloutMeta>>();
const rolloutPathCache = new Map<string, Map<string, string>>();
const activeScans = new Map<string, Promise<RolloutEntry[]>>();

/** Every rollout file under the account's config dir, newest filename first. */
export async function rolloutFiles(configDir: string): Promise<string[]> {
  const root = join(configDir, 'sessions');
  const found: string[] = [];
  // sessions/YYYY/MM/DD/*.jsonl — a fixed three-level date bucket. Directory
  // entries carry their type, avoiding one blocking/stat syscall per path.
  for (const year of await subdirs(root)) {
    const yearDir = join(root, year);
    for (const month of await subdirs(yearDir)) {
      const monthDir = join(yearDir, month);
      for (const day of await subdirs(monthDir)) {
        const dayDir = join(monthDir, day);
        for (const entry of await safeReaddir(dayDir)) {
          if (
            (entry.isFile() || entry.isSymbolicLink()) &&
            entry.name.startsWith('rollout-') &&
            entry.name.endsWith('.jsonl')
          ) {
            found.push(join(dayDir, entry.name));
          }
        }
      }
    }
  }
  // Date buckets and ISO-like filenames make lexical order chronological.
  return found.sort().reverse();
}

/** The bounded `session_meta` header of a rollout, or null when unreadable. */
export async function readRolloutMeta(path: string): Promise<RolloutMeta | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const head = Buffer.allocUnsafe(HEADER_BYTES);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const firstNewline = head.subarray(0, bytesRead).indexOf(0x0a);
    const end = firstNewline === -1 ? bytesRead : firstNewline;
    const line = head.subarray(0, end).toString('utf8');
    if (line.trim() === '') return null;
    const record = JSON.parse(line) as RolloutLine;
    const id = record.payload?.id;
    const cwd = record.payload?.cwd;
    if (id === undefined || cwd === undefined) return null;
    const timestamp = record.payload?.timestamp;
    const parsedTimestamp = timestamp === undefined ? NaN : Date.parse(timestamp);
    return {
      id,
      cwd,
      createdAt: Number.isFinite(parsedTimestamp) ? parsedTimestamp : null,
      parentThreadId: record.payload?.parent_thread_id ?? null,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Account-wide metadata index. Polls still enumerate filenames so a new
 * rollout is noticed, but only new/unreadable files need an open+header read.
 * Concurrent status and launch polls share one scan.
 */
async function rolloutEntries(configDir: string): Promise<RolloutEntry[]> {
  const active = activeScans.get(configDir);
  if (active) return active;
  const scan = (async () => {
    const cached = metadataCache.get(configDir) ?? new Map<string, RolloutMeta>();
    const pathsByRef = rolloutPathCache.get(configDir) ?? new Map<string, string>();
    metadataCache.set(configDir, cached);
    rolloutPathCache.set(configDir, pathsByRef);
    const paths = await rolloutFiles(configDir);
    const live = new Set(paths);
    for (const [path, meta] of cached) {
      if (live.has(path)) continue;
      cached.delete(path);
      if (pathsByRef.get(meta.id) === path) pathsByRef.delete(meta.id);
    }
    const unread = paths.filter((path) => !cached.has(path));
    for (let offset = 0; offset < unread.length; offset += READ_CONCURRENCY) {
      const batch = unread.slice(offset, offset + READ_CONCURRENCY);
      const parsed = await Promise.all(
        batch.map(async (path) => ({ path, meta: await readRolloutMeta(path) })),
      );
      for (const { path, meta } of parsed) {
        // An opening rollout can exist before its first line is readable. Do
        // not cache failure: the next poll must retry it.
        if (meta !== null) {
          cached.set(path, meta);
          pathsByRef.set(meta.id, path);
        }
      }
    }
    return paths.flatMap((path) => {
      const meta = cached.get(path);
      return meta === undefined ? [] : [{ path, meta }];
    });
  })().finally(() => {
    if (activeScans.get(configDir) === scan) activeScans.delete(configDir);
  });
  activeScans.set(configDir, scan);
  return scan;
}

/** Every cached rollout, including parent metadata for top-level forks. */
export async function allRollouts(configDir: string): Promise<RolloutMeta[]> {
  return (await rolloutEntries(configDir)).map((entry) => entry.meta);
}

/** Exact path already learnt by discovery, without touching the filesystem. */
export function cachedRolloutPath(configDir: string, ref: string): string | null {
  return rolloutPathCache.get(configDir)?.get(ref) ?? null;
}

/** Top-level rollouts recorded against `worktreePath`, newest first. */
export async function rolloutsFor(configDir: string, worktreePath: string): Promise<RolloutMeta[]> {
  return (await rolloutEntries(configDir))
    .map((entry) => entry.meta)
    .filter((meta) => sameNativeCwd(meta.cwd, worktreePath) && meta.parentThreadId === null);
}

/** Newest unclaimed top-level rollout recorded against `worktreePath`. */
export async function newestRolloutFor(
  configDir: string,
  worktreePath: string,
  excludeRefs: ReadonlySet<string> = new Set(),
): Promise<RolloutMeta | undefined> {
  return (await rolloutsFor(configDir, worktreePath)).find((meta) => !excludeRefs.has(meta.id));
}

/** Top-level rollout whose id is `ref`, with metadata validated. */
export async function rolloutForRef(configDir: string, ref: string): Promise<RolloutEntry | null> {
  return (
    (await rolloutEntries(configDir)).find(
      (entry) => entry.meta.id === ref && entry.meta.parentThreadId === null,
    ) ?? null
  );
}

/**
 * The conversation as readable text for a cross-agent hand-off (SPEC §5).
 * Streaming keeps a very large transcript from becoming one long synchronous
 * read/parse turn. Only user/agent messages survive; tool calls are collapsed.
 */
export async function renderRollout(path: string): Promise<string> {
  const out: string[] = [];
  let toolCalls = 0;
  const flushTools = () => {
    if (toolCalls > 0) out.push(`_(ran ${toolCalls} tool call${toolCalls === 1 ? '' : 's'})_`);
    toolCalls = 0;
  };
  let input;
  try {
    input = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim() === '') continue;
      let record: RolloutLine;
      try {
        record = JSON.parse(line) as RolloutLine;
      } catch {
        continue;
      }
      if (record.type !== 'event_msg' && record.type !== 'response_item') continue;
      const kind = record.payload?.type;
      if (kind === 'function_call' || kind === 'custom_tool_call') {
        toolCalls++;
        continue;
      }
      if (record.type !== 'event_msg') continue;
      if (kind !== 'user_message' && kind !== 'agent_message') continue;
      const text = (record.payload?.message ?? record.payload?.text ?? '').trim();
      if (text === '') continue;
      flushTools();
      out.push(`## ${kind === 'user_message' ? 'User' : 'Assistant'}\n\n${text}`);
    }
  } catch {
    input?.destroy();
    return '';
  }
  flushTools();
  return out.join('\n\n');
}

async function subdirs(dir: string): Promise<string[]> {
  return (await safeReaddir(dir)).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
