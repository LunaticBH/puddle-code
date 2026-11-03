import { prepareOpenCodeInteractive } from './control.js';
import { prepareOpenCodeHeadless } from './headless.js';
import { mkdirSync, readFileSync, type Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AgentAdapter } from '../adapter.js';
import { agentEnv, execAgent } from '../agent-process.js';
import { matchesAgentProcess } from '../process-match.js';
import { sameNativeCwd } from '../native-cwd.js';
import { installOpenCodePlugin } from './plugin.js';
import { lifecycleVersionAtLeast } from '../lifecycle-version.js';
import { CACHE_HOME, CONFIG_HOME, DATA_HOME, STATE_HOME, xdgEnv } from './xdg.js';

const SESSION_START_WINDOW_MS = 5 * 60 * 1000;
const METADATA_CONCURRENCY = 32;

/**
 * OpenCode adapter.
 *
 * Verified against opencode 1.18.10 (2026-07-31) with `--help` and
 * `opencode debug paths` on a scratch install:
 * - **Isolation is XDG-based, and needs four variables.** opencode splits its
 *   state across `~/.config/opencode`, `~/.local/share/opencode` (which holds
 *   `auth.json` AND the session store), `~/.cache/opencode` and
 *   `~/.local/state/opencode`. `debug paths` confirms `XDG_CONFIG_HOME`,
 *   `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` relocate all of them.
 *   **`OPENCODE_CONFIG_DIR` relocates NOTHING** — verified: with it set, every
 *   reported path stayed at the real `~/…`. It is for agent/command/plugin
 *   discovery only and is useless for account isolation, so it is not used here.
 * - Caveat: `XDG_CONFIG_HOME` is not opencode-specific, so git commands the
 *   agent runs no longer see `$XDG_CONFIG_HOME/git/*`. Verified that identity
 *   survives — `user.name`/`user.email` come from `~/.gitconfig`, which is
 *   HOME-based — but a user's XDG-located global gitignore will not apply
 *   inside opencode sessions. Accepted: credential isolation matters more.
 * - `--auto` = "auto-approve permissions that are not explicitly denied
 *   (dangerous!)", so `skipPermissions: true`. SPEC §5 previously said
 *   opencode's permissions were "configured rather than flagged"; that is out
 *   of date and has been corrected.
 * - `-s/--session <id>` continues a session, `-c/--continue` the last one, and
 *   `--prompt <text>` seeds the first message. Session ids are `ses_`-prefixed
 *   and minted by opencode, so `presetSessionId: false`.
 * - Auth is `opencode providers`, aliased **`auth`**: `auth login` / `auth list`
 *   / `auth logout`. `auth list` reports configured providers; checkLoggedIn
 *   treats "at least one provider" as authenticated.
 * - `opencode export <sessionID>` emits the session as JSON — a first-class
 *   transcript source, so exportTranscript shells out rather than parsing the
 *   on-disk store.
 * - Puddle's managed plugin consumes top-level session lifecycle/status
 *   events. A session carrying parentID is a child and never changes the live
 *   Puddle placement; keep the real-agent cases in docs/acceptance pinned when
 *   upgrading beyond 1.18.10.
 *
 * - Windows (from opencode's source, dev branch 2026-11; not run live, as no
 *   OpenCode was installed on the port machine): the XDG roots come from
 *   `XDG_*_HOME` with `~/.config`, `~/.local/share`, `~/.cache` and
 *   `~/.local/state` fallbacks on every platform, never `%APPDATA%`, so the
 *   same four variables isolate a Windows account.
 *
 * No `conversationShare`: sessions are per-project JSON files under the data
 * dir rather than per-conversation directories, so the Workstream S store model
 * does not apply and `migratableSessions` is false.
 */
export const opencode: AgentAdapter = {
  scriptedTurns: true,
  prepareHeadlessLaunch: prepareOpenCodeHeadless,
  prepareLifecycleLaunch: prepareOpenCodeInteractive,
  id: 'opencode',
  displayName: 'OpenCode',
  binary: 'opencode',
  matchesProcess: (command) =>
    matchesAgentProcess(command, 'opencode', ['opencode-ai/bin/opencode']),
  capabilities: {
    resume: true,
    presetSessionId: false,
    skipPermissions: true,
    migratableSessions: false,
  },

  env(account) {
    return xdgEnv(account.config_dir);
  },

  prepareConfigDir(configDir) {
    // opencode creates its own <root>/opencode subdirs; the XDG roots must exist.
    for (const sub of [CONFIG_HOME, DATA_HOME, CACHE_HOME, STATE_HOME]) {
      mkdirSync(join(configDir, sub), { recursive: true });
    }
    installOpenCodePlugin(configDir);
  },

  reconcileConfigDir(account) {
    installOpenCodePlugin(account.config_dir);
  },

  launchArgs(opts) {
    return [
      ...(opts.skipPermissions ? ['--auto'] : []),
      ...(opts.prompt !== undefined ? ['--prompt', opts.prompt] : []),
    ];
  },

  resumeArgs(ref, opts) {
    return [
      '--session',
      ref,
      ...(opts.skipPermissions ? ['--auto'] : []),
      ...(opts.prompt !== undefined ? ['--prompt', opts.prompt] : []),
    ];
  },

  loginArgs() {
    // Deliberately NOT the bare TUI (unlike claude-code/codex/gemini-cli,
    // decision 2026-08-06): `auth login` is opencode's own interactive
    // provider picker, renders entirely in the PTY, and exits cleanly on its
    // own once the credential is saved — exactly what the login dialogue
    // wants, with no REPL to escape from.
    return ['auth', 'login'];
  },

  async checkLoggedIn(account) {
    try {
      const { stdout } = await execAgent('opencode', ['auth', 'list'], {
        env: agentEnv(xdgEnv(account.config_dir)),
        timeout: 15_000,
      });
      // `auth list` exits 0 whether or not anything is configured, so the
      // signal is the credential store itself plus a non-empty listing.
      return authFileHasProvider(account.config_dir) || /\S/.test(stripHeading(stdout));
    } catch {
      return false; // missing binary / timeout / unparsable
    }
  },

  async existingSessionRefs(worktreePath, account) {
    return new Set(
      (await sessionsFor(account.config_dir, worktreePath)).map((session) => session.id),
    );
  },

  async resolveSessionRef(opts, account, excludeRefs = new Set()) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const ref = await newestSessionId(account.config_dir, opts.worktreePath, excludeRefs);
      if (ref !== null) return ref;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // Unresolved placeholder: the coordinator does not persist it and retries
    // on status/title refreshes (with resume recovery as the final backstop).
    return opts.sessionId;
  },

  async discoverSessionRef(worktreePath, account, context) {
    const candidates = (await sessionsFor(account.config_dir, worktreePath)).filter(
      (session) => !context?.excludeRefs?.has(session.id),
    );
    if (context === undefined) return candidates[0]?.id ?? null;
    return sessionBornFor(candidates, context.nativeCreatedAt ?? context.createdAt)?.id ?? null;
  },

  async hasConversation(ref, account) {
    return (await sessionsFor(account.config_dir)).some((session) => session.id === ref);
  },

  async sessionRefMatches(ref, context, account) {
    return (
      sessionBornFor(
        (await sessionsFor(account.config_dir, context.worktreePath)).filter(
          (candidate) => !context.excludeRefs?.has(candidate.id),
        ),
        context.nativeCreatedAt ?? context.createdAt,
      )?.id === ref
    );
  },

  async exportTranscript(ref, account) {
    try {
      const { stdout } = await execAgent('opencode', ['export', ref], {
        env: agentEnv(xdgEnv(account.config_dir)),
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      return renderExport(stdout);
    } catch {
      return ''; // caller falls back to the PTY log tail
    }
  },

  conversationDiscovery: {
    watchRoots: (account) => [join(dataDir(account.config_dir), 'storage', 'session')],
    discover: async (account) =>
      (await allSessions(account.config_dir))
        .filter((session) => session.parentID === null)
        .map((session) => ({
          ref: session.id,
          cwd: session.directory,
          title: session.title,
          parentRef: null,
          createdAt: session.createdAt === null ? null : new Date(session.createdAt).toISOString(),
          updatedAt: new Date(session.updatedAt).toISOString(),
        })),
  },
  lifecycleSignals: true,
  checkLifecycleSupport: () => lifecycleVersionAtLeast('opencode', ['--version'], [1, 18, 10]),

  /**
   * UNVERIFIED against a live session (opencode needs a configured provider to
   * reach its composer). Confirm via docs/acceptance/phase-7-agents.md and
   * correct here — opencode has no hook side-channel, so these are its only
   * status driver.
   */
  statusPatterns: {
    waitingInput: [/esc\s+interrupt/i, /^\s*>\s*$/m],
    busy: [/working/i, /thinking/i],
  },
};

/** opencode's own data root inside the account dir. */
function dataDir(configDir: string): string {
  return join(configDir, DATA_HOME, 'opencode');
}

function authFileHasProvider(configDir: string): boolean {
  try {
    const raw = readFileSync(join(dataDir(configDir), 'auth.json'), 'utf8');
    return Object.keys(JSON.parse(raw) as Record<string, unknown>).length > 0;
  } catch {
    return false;
  }
}

/** Drops `auth list`'s banner/heading lines so "no providers" reads as empty. */
function stripHeading(stdout: string): string {
  return stdout
    .split('\n')
    .filter((line) => !/^\s*(#|─|━|Credentials|Providers)/i.test(line))
    .join('\n');
}

/**
 * Newest session id recorded for `worktreePath`.
 *
 * The store lives under `<data>/opencode/storage/session/<project>/<ses_*>.json`.
 * The exact project keying is opencode's own and is not reproduced here: every
 * session file is read and matched on the directory it records, so a layout
 * change costs a scan rather than a wrong answer. Returns null when nothing
 * matches — including when the layout is not what this expects, which the
 * acceptance script exists to catch.
 */
interface StoredSession {
  id: string;
  directory: string;
  title: string | null;
  parentID: string | null;
  createdAt: number | null;
  updatedAt: number;
}

interface CachedSession {
  size: number;
  mtimeMs: number;
  session: StoredSession;
}

const sessionCache = new Map<string, Map<string, CachedSession>>();
const activeSessionScans = new Map<string, Promise<StoredSession[]>>();

/**
 * Asynchronous, incremental view of OpenCode's metadata store. A large imported
 * account used to synchronously walk and parse every JSON file on each 150 ms
 * ref poll, freezing all daemon traffic. Directory enumeration and stats now
 * yield, unchanged files stay parsed in the cache, and concurrent ticks share
 * one scan.
 */
async function sessionsFor(configDir: string, worktreePath?: string): Promise<StoredSession[]> {
  // `parentID` identifies child/subagent sessions. They are native side
  // threads, never the top-level conversation a Puddle runtime owns.
  const all = (await allSessions(configDir)).filter((session) => session.parentID === null);
  return worktreePath === undefined
    ? all
    : all.filter((session) => sameNativeCwd(session.directory, worktreePath));
}

async function allSessions(configDir: string): Promise<StoredSession[]> {
  const active = activeSessionScans.get(configDir);
  if (active) return active;
  const scan = scanSessions(configDir).finally(() => {
    if (activeSessionScans.get(configDir) === scan) activeSessionScans.delete(configDir);
  });
  activeSessionScans.set(configDir, scan);
  return scan;
}

async function scanSessions(configDir: string): Promise<StoredSession[]> {
  // Keep the snapshot genuinely behind the create response, not merely behind
  // a promise microtask that would still run before socket I/O gets a turn.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const root = join(dataDir(configDir), 'storage', 'session');
  const cached = sessionCache.get(configDir) ?? new Map<string, CachedSession>();
  sessionCache.set(configDir, cached);
  const found: StoredSession[] = [];
  const files = await walkJson(root, 3);
  const live = new Set(files);
  for (const file of cached.keys()) if (!live.has(file)) cached.delete(file);
  for (let offset = 0; offset < files.length; offset += METADATA_CONCURRENCY) {
    const batch = files.slice(offset, offset + METADATA_CONCURRENCY);
    const entries = await Promise.all(batch.map((file) => readStoredSession(file, cached)));
    for (const entry of entries) {
      if (entry !== null) found.push(entry.session);
    }
  }
  return found.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function readStoredSession(
  file: string,
  cached: Map<string, CachedSession>,
): Promise<CachedSession | null> {
  const name = basename(file);
  if (!name.startsWith('ses_') || !name.endsWith('.json')) return null;
  try {
    const stats = await stat(file);
    let entry = cached.get(file);
    if (entry !== undefined && entry.size === stats.size && entry.mtimeMs === stats.mtimeMs) {
      return entry;
    }
    const record = JSON.parse(await readFile(file, 'utf8')) as {
      id?: string;
      directory?: string;
      cwd?: string;
      title?: string;
      parentID?: string;
      time?: { updated?: number; created?: number };
    };
    const dir = record.directory ?? record.cwd;
    if (dir === undefined) return null;
    const createdAt = normaliseEpoch(record.time?.created);
    entry = {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      session: {
        id: record.id ?? name.slice(0, -'.json'.length),
        directory: dir,
        title: typeof record.title === 'string' ? record.title.trim().slice(0, 80) || null : null,
        parentID: typeof record.parentID === 'string' ? record.parentID : null,
        createdAt,
        updatedAt: normaliseEpoch(record.time?.updated) ?? createdAt ?? 0,
      },
    };
    cached.set(file, entry);
    return entry;
  } catch {
    return null; // unreadable or unexpected shape — skip
  }
}

async function newestSessionId(
  configDir: string,
  worktreePath: string,
  excludeRefs: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  return (
    (await sessionsFor(configDir, worktreePath)).find((session) => !excludeRefs.has(session.id))
      ?.id ?? null
  );
}

function sessionBornFor<T extends { createdAt: number | null }>(
  candidates: T[],
  sessionCreatedAt: string,
): T | undefined {
  const createdAt = Date.parse(sessionCreatedAt);
  if (!Number.isFinite(createdAt)) return undefined;
  const ranked = candidates
    .filter(
      (candidate) =>
        candidate.createdAt !== null &&
        candidate.createdAt >= createdAt - 5_000 &&
        candidate.createdAt <= createdAt + SESSION_START_WINDOW_MS,
    )
    .sort((a, b) => Math.abs(a.createdAt! - createdAt) - Math.abs(b.createdAt! - createdAt));
  const best = ranked[0];
  const second = ranked[1];
  if (
    best !== undefined &&
    second !== undefined &&
    Math.abs(second.createdAt! - createdAt) - Math.abs(best.createdAt! - createdAt) < 15_000
  ) {
    return undefined; // too close to prove ownership safely
  }
  return best;
}

/** OpenCode currently stores epoch milliseconds; tolerate seconds from older builds. */
function normaliseEpoch(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}

/** Absolute paths of every .json file under `dir`, to a bounded depth. */
async function walkJson(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkJson(path, depth - 1)));
    else if (entry.name.endsWith('.json')) out.push(path);
  }
  return out;
}

/**
 * `opencode export` JSON → readable text. Only user/assistant text parts are
 * kept; tool invocations collapse to a count, matching the other adapters.
 */
function renderExport(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return stdout.trim(); // not JSON after all — better than nothing
  }
  const messages = extractMessages(parsed);
  if (messages === null) return '';
  const out: string[] = [];
  let toolCalls = 0;
  const flushTools = () => {
    if (toolCalls > 0) out.push(`_(ran ${toolCalls} tool call${toolCalls === 1 ? '' : 's'})_`);
    toolCalls = 0;
  };
  for (const message of messages) {
    const role = message.role === 'user' ? 'User' : 'Assistant';
    const text: string[] = [];
    for (const part of message.parts ?? []) {
      if (part.type === 'tool' || part.type === 'tool-invocation') toolCalls++;
      else if (typeof part.text === 'string' && part.text.trim() !== '')
        text.push(part.text.trim());
    }
    if (text.length === 0) continue;
    flushTools();
    out.push(`## ${role}\n\n${text.join('\n\n')}`);
  }
  flushTools();
  return out.join('\n\n');
}

interface ExportedMessage {
  role?: string;
  parts?: Array<{ type?: string; text?: string }>;
}

function extractMessages(parsed: unknown): ExportedMessage[] | null {
  if (Array.isArray(parsed)) return parsed as ExportedMessage[];
  if (parsed !== null && typeof parsed === 'object') {
    const messages = (parsed as { messages?: unknown }).messages;
    if (Array.isArray(messages)) return messages as ExportedMessage[];
  }
  return null;
}
