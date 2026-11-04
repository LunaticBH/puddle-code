import { prepareClaudeInteractive } from './control.js';
import { prepareClaudeHeadless } from './headless.js';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { cp, open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AgentAdapter, AgentUsage } from '../adapter.js';
import { agentEnv, execAgent } from '../agent-process.js';
import { sameNativeCwd } from '../native-cwd.js';
import { claudeConversationShare } from './share.js';
import { installStatusHooks } from './hooks.js';
import { installStatusLine, readLiveUsage } from './statusline.js';
import { fetchSubscriptionUsage } from './usage-cli.js';
import { lifecycleVersionAtLeast } from '../lifecycle-version.js';
import { matchesAgentProcess } from '../process-match.js';
import { lastJsonlOutput } from '../notification-output.js';

/**
 * Per-file token subtotals keyed by absolute path, invalidated on
 * (size, mtimeMs) change — conversation JSONLs only ever grow, so a warm
 * cache reparses nothing and a live session's file is re-read only when it
 * has actually changed since the last usage call.
 */
const usageCache = new Map<string, { size: number; mtimeMs: number; usage: AgentUsage }>();

const EMPTY_USAGE: AgentUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  message_count: 0,
};

/**
 * Claude Code adapter.
 *
 * Flags verified against Claude Code 2.1.208 (2026-07-14):
 * - `--session-id <uuid>` accepted at launch ("must be a valid UUID") → we
 *   preset it to the puddle session id, so agent_session_ref === sessions.id.
 * - `--resume <uuid>` restores a conversation; a positional prompt after it
 *   is submitted on resume (used for the interrupted-restart note). A ref
 *   with no conversation file fails with "No conversation found" (exit 1).
 * - `--dangerously-skip-permissions` bypasses permission prompts, but ONLY once
 *   the config dir records `bypassPermissionsModeAccepted: true` in .claude.json.
 *   Without it, 2.1.x silently downgrades the flag to default ("Permission mode
 *   downgraded to default — bypass requires accepting the disclaimer
 *   interactively first"), so a non-interactive PTY session keeps its prompts.
 *   The disclaimer is otherwise an interactive dialog; puddle writes the flag
 *   only when the user opens the profile skip gate — see acceptSkipPermissions
 *   (verified against Claude Code 2.1.210).
 * - Login runs the bare TUI (see loginArgs); `auth status` verifies it.
 *   `claude auth login` was used through v0.0.28 but has no method picker
 *   (verified 2.1.223): it goes straight to subscription OAuth, with Console
 *   (API billing) and SSO only reachable via --console/--sso flags — the
 *   TUI's "Select login method" screen is the one place the user can choose.
 *   Signing in (either route) writes `oauthAccount` into
 *   `<config_dir>/.claude.json` but does NOT set `hasCompletedOnboarding` —
 *   only the TUI's first-run wizard does. An unset flag makes the first
 *   session run that wizard (theme → sign-in AGAIN → trust), and the wizard
 *   DISCARDS a preset `--session-id`, which also breaks resume. Hence
 *   prepareConfigDir seeds the flag at account creation, before anything
 *   else runs.
 * - macOS keychain OAuth entries are bound to the config-dir PATH: renaming
 *   or copying the dir silently logs the account out while .claude.json still
 *   carries oauthAccount (verified 2.1.208 — migration 004's dir rename did
 *   exactly this). Hence checkLoggedIn asks `auth status` instead of trusting
 *   any stored flag. The login screen, like the wizard, DISCARDS a preset
 *   --session-id — discoverSessionRef recovers the conversation by the cwd
 *   recorded in its JSONL.
 * - `claude -p /usage` prints the subscription rate-limit windows as plain
 *   text (verified 2.1.209) — see claude-usage-cli.ts, including the
 *   API-key-suppresses-the-windows gotcha.
 * - Additive SessionStart/SessionEnd hooks carry session_id, cwd, source, and
 *   fork parent where present (payload names verified against 2.1.238). They
 *   coexist with Puddle's status hooks and any user hooks.
 * - `CLAUDE_CONFIG_DIR` relocates all state: conversation JSONL lands at
 *   `<config_dir>/projects/<escaped-realpath-cwd>/<uuid>.jsonl`. For a git
 *   WORKTREE cwd the project dir is escaped from the MAIN repository root,
 *   not the worktree path — so conversation lookup scans every project dir
 *   rather than computing the escaped name.
 * - Windows (checked against the native installer's claude.exe 2.1.248 on
 *   Windows 11): `CLAUDE_CONFIG_DIR` relocates state as above (default
 *   `%USERPROFILE%\.claude`), project dirs are named like `C--Users-…` and
 *   the JSONL records backslash cwds, compared through sameNativeCwd. Hooks
 *   use exec form and the status line is a command every shell Claude may
 *   pick runs alike; see hook-command.ts.
 *
 * COPY-ON-SELECT, and why puddle cannot suppress it (investigated 2026-08-05,
 * against 2.1.222). Dragging a selection in the TUI copies it, and its
 * `setClipboard` writes the clipboard TWICE: `OSC 52 ; c ; …` for the terminal,
 * AND — whenever it does not believe it is remote — the host clipboard directly
 * (`pbcopy` on macOS, `wl-copy`/`xclip`/`xsel` on Linux). The web terminal holds
 * the OSC 52 payload back until the copy chord (`Terminal.tsx`, SPEC §7), but a
 * spawned process writing the host pasteboard is out of the browser's reach
 * entirely — so with a LOCAL daemon, highlighting still lands on the user's
 * clipboard, from the daemon's side of the wire. (With a remote daemon it writes
 * that host's clipboard, where nobody sees it.)
 *
 * Its own switches are the fix: `copyOnSelect` (default ON) under /config →
 * Input & controls, which the TUI itself hints at ("disable auto-copy in
 * /config"). The native half is gated on `SSH_CONNECTION` (or an attacher
 * capability), so exporting that into the PTY would also route it through OSC 52
 * — deliberately NOT done: it fabricates environment state every tool in the
 * session reads, to fix one agent's setting.
 */
export const claudeCode: AgentAdapter = {
  scriptedTurns: true,
  prepareHeadlessLaunch: prepareClaudeHeadless,
  prepareLifecycleLaunch: prepareClaudeInteractive,
  id: 'claude-code',
  displayName: 'Claude Code',
  binary: 'claude',
  matchesProcess: (command) =>
    matchesAgentProcess(command, 'claude', ['@anthropic-ai/claude-code/cli.js']),
  capabilities: {
    resume: true,
    presetSessionId: true,
    skipPermissions: true,
    migratableSessions: true,
  },

  env(account) {
    return { CLAUDE_CONFIG_DIR: account.config_dir };
  },

  prepareConfigDir(configDir) {
    // The dir is puddle-created and empty at this point; auth login and the
    // TUI merge into this file rather than replacing it.
    writeFileSync(
      join(configDir, '.claude.json'),
      `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    installStatusLine(configDir); // live-usage capture (context fill, cost)
    installStatusHooks(configDir); // hook-driven running ⇄ waiting_input signals
  },

  async importConfigDir(sourceDir, configDir) {
    // Bytes are copied opaquely — nothing is parsed except .claude.json,
    // which needs the same onboarding seed as a fresh dir. On macOS the
    // OAuth token is keychain-bound to the ORIGINAL dir path and does not
    // travel; checkLoggedIn reports the truth afterwards.
    await cp(sourceDir, configDir, { recursive: true });
    const stateFile = join(configDir, '.claude.json');
    let state: Record<string, unknown> = {};
    if (existsSync(stateFile)) {
      try {
        state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
      } catch {
        // An unreadable state file gets replaced by the minimal seed.
      }
    }
    state['hasCompletedOnboarding'] = true;
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    installStatusLine(configDir); // respects an imported account's own statusLine
    installStatusHooks(configDir); // additive beside any imported hooks
  },

  acceptSkipPermissions(account) {
    // The user has opened the profile skip-permissions gate (SPEC §11) — the
    // human confirmation. Record Claude's dangerous-mode disclaimer acceptance
    // so `--dangerously-skip-permissions` actually bypasses prompts; otherwise
    // 2.1.x downgrades it to default in a non-interactive PTY. Merge so
    // oauthAccount and everything else in .claude.json survive.
    const file = join(account.config_dir, '.claude.json');
    let state: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      } catch {
        // An unreadable file is replaced by the minimal record.
      }
    }
    state['bypassPermissionsModeAccepted'] = true;
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  },

  async checkLoggedIn(account) {
    try {
      const { stdout } = await execAgent('claude', ['auth', 'status'], {
        env: agentEnv({ CLAUDE_CONFIG_DIR: account.config_dir }),
        timeout: 15_000,
      });
      const status = JSON.parse(stdout) as { loggedIn?: boolean };
      return status.loggedIn === true;
    } catch {
      return false; // no binary / timeout / unparsable → not verifiably logged in
    }
  },

  discoverSessionRef(worktreePath, account) {
    const projectsDir = join(account.config_dir, 'projects');
    if (!existsSync(projectsDir)) return null;
    const targets = new Set([worktreePath]);
    try {
      targets.add(realpathSync(worktreePath)); // /var vs /private/var on macOS
    } catch {
      // A vanished worktree still matches on the recorded string.
    }
    const matches = (cwd: string) => [...targets].some((target) => sameNativeCwd(cwd, target));
    let best: { ref: string; mtime: number } | null = null;
    for (const dir of readdirSync(projectsDir)) {
      let files: string[];
      try {
        files = readdirSync(join(projectsDir, dir));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const path = join(projectsDir, dir, file);
        if (!conversationCwdMatches(path, matches)) continue;
        const mtime = statSync(path).mtimeMs;
        // Newest wins: a worktree can host successive conversations.
        if (!best || mtime > best.mtime) best = { ref: file.slice(0, -'.jsonl'.length), mtime };
      }
    }
    return best?.ref ?? null;
  },

  hasConversation(ref, account) {
    const projectsDir = join(account.config_dir, 'projects');
    if (!existsSync(projectsDir)) return false;
    return readdirSync(projectsDir).some((dir) =>
      existsSync(join(projectsDir, dir, `${ref}.jsonl`)),
    );
  },

  sessionTitle(ref, account) {
    return transcriptEntry(account.config_dir, ref)?.title ?? null;
  },

  async notificationOutput(ref, account) {
    // Prefer the exact cached path; discovery remains metadata-only.
    let path = transcriptCache.get(`${account.config_dir}:${ref}`)?.path;
    if (!path) {
      const root = join(account.config_dir, 'projects');
      for (const dir of await readdir(root).catch(() => [])) {
        const candidate = join(root, dir, `${ref}.jsonl`);
        if (await stat(candidate).catch(() => null)) {
          path = candidate;
          break;
        }
      }
    }
    if (!path) return null;
    return lastJsonlOutput(path, (record) => {
      const message = record.message as
        { content?: string | { type?: string; text?: string }[] } | undefined;
      const content = message?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((part) => part.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text)
                .join('\n')
            : '';
      if (record.type === 'assistant' && text) return text;
      if (record.type === 'user' && text) return null;
      return undefined;
    });
  },

  async exportTranscript(ref, account) {
    const projectsDir = join(account.config_dir, 'projects');
    if (!existsSync(projectsDir)) return '';
    for (const dir of readdirSync(projectsDir)) {
      const path = join(projectsDir, dir, `${ref}.jsonl`);
      if (existsSync(path)) return renderTranscript(path);
    }
    return '';
  },

  sessionActivityAt(ref, account) {
    const entry = transcriptEntry(account.config_dir, ref);
    return entry ? new Date(entry.mtimeMs) : null;
  },

  usageStats(account) {
    const projectsDir = join(account.config_dir, 'projects');
    if (!existsSync(projectsDir)) return null;
    const total = { ...EMPTY_USAGE };
    let sawFile = false;
    for (const dir of readdirSync(projectsDir)) {
      let files: string[];
      try {
        files = readdirSync(join(projectsDir, dir));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        sawFile = true;
        addUsage(total, fileUsage(join(projectsDir, dir, file)));
      }
    }
    return sawFile ? total : null;
  },

  liveUsage(account) {
    return readLiveUsage(account.config_dir);
  },

  // Shared conversation store hooks (Workstream S); see claude-share.ts for the
  // pinned verification block. Consequence: after adoption every account of the
  // profile reads the SAME conversation JSONLs through its symlink, so
  // usageStats/hasConversation report identical conversations for them all.
  conversationShare: claudeConversationShare,

  conversationDiscovery: {
    watchRoots: (account) => [join(account.config_dir, 'projects')],
    discover: (account) => discoverClaudeConversations(account.config_dir),
  },
  lifecycleSignals: true,
  checkLifecycleSupport: () => lifecycleVersionAtLeast('claude', ['--version'], [2, 1, 238]),

  subscriptionUsage(account) {
    return fetchSubscriptionUsage(account);
  },

  reconcileConfigDir(account) {
    // Bring pre-existing accounts up to the current setup (idempotent, and
    // it never clobbers a status line or hooks the account already defines).
    if (existsSync(account.config_dir)) {
      installStatusLine(account.config_dir);
      installStatusHooks(account.config_dir);
    }
  },

  launchArgs(opts) {
    return [
      '--session-id',
      opts.sessionId,
      ...(opts.skipPermissions ? ['--dangerously-skip-permissions'] : []),
      ...(opts.prompt !== undefined ? [opts.prompt] : []),
    ];
  },

  resumeArgs(ref, opts) {
    return [
      '--resume',
      ref,
      ...(opts.skipPermissions ? ['--dangerously-skip-permissions'] : []),
      ...(opts.prompt !== undefined ? [opts.prompt] : []),
    ];
  },

  loginArgs() {
    // The bare TUI, not `auth login` (decision 2026-08-05, verified 2.1.223):
    // `auth login` has NO method picker — it goes straight to the Claude
    // subscription OAuth flow, and Console (API billing) / SSO are reachable
    // only via its --console/--sso flags. The TUI's own login screen ("Select
    // login method") offers the choice, so the login PTY runs the full TUI —
    // hasCompletedOnboarding is already seeded, so an unauthenticated launch
    // lands on that screen directly. The cost: after sign-in it sits in the
    // REPL rather than exiting, so loginHint tells the user how to leave, and
    // the accounts route verifies `auth status` on exit rather than trusting
    // exit code 0 (quitting WITHOUT signing in also exits cleanly).
    return [];
  },
  loginHint:
    'Already signed in and switching accounts? Type /login. When you are done, type /exit (or press Ctrl+C twice) to finish.',

  async resolveSessionRef(opts) {
    return opts.sessionId; // preset via --session-id
  },

  statusPatterns: {
    // Initial heuristics for the 2.1.x TUI; refine during the Phase 1
    // acceptance run against real output. The bordered input box renders
    // "│ >" when idle; "esc to interrupt" is shown while working.
    waitingInput: [/│\s?>/],
    busy: [/esc to interrupt/i],
    limitReached: [/usage limit reached/i, /out of extra usage/i],
  },
};

/**
 * Transcript lookup cache backing `sessionTitle` and `sessionActivityAt`,
 * keyed by `${configDir}:${ref}`. The title-refresh loop calls these every
 * few seconds per live agent, so the steady state must be one `stat` — the
 * path resolution (a readdir sweep) and the title scan (a 128 KiB read+parse)
 * only re-run when (size, mtimeMs) changed. A vanished file drops its entry
 * and re-resolves, so a transcript moved between config dirs is found again.
 */
interface TranscriptEntry {
  path: string;
  size: number;
  mtimeMs: number;
  title: string | null;
}
const transcriptCache = new Map<string, TranscriptEntry>();

function findTranscript(configDir: string, ref: string): string | null {
  const projectsDir = join(configDir, 'projects');
  if (!existsSync(projectsDir)) return null;
  for (const dir of readdirSync(projectsDir)) {
    const path = join(projectsDir, dir, `${ref}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

function transcriptEntry(configDir: string, ref: string): TranscriptEntry | null {
  const cacheKey = `${configDir}:${ref}`;
  const cached = transcriptCache.get(cacheKey);
  if (cached) {
    try {
      const stats = statSync(cached.path);
      if (stats.size === cached.size && stats.mtimeMs === cached.mtimeMs) return cached;
      const fresh: TranscriptEntry = {
        path: cached.path,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        title: readSessionTitle(cached.path),
      };
      transcriptCache.set(cacheKey, fresh);
      return fresh;
    } catch {
      transcriptCache.delete(cacheKey); // gone — fall through and re-resolve
    }
  }
  const path = findTranscript(configDir, ref);
  if (path === null) return null;
  try {
    const stats = statSync(path);
    const entry: TranscriptEntry = {
      path,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      title: readSessionTitle(path),
    };
    transcriptCache.set(cacheKey, entry);
    return entry;
  } catch {
    return null;
  }
}

/** Bounded window read for the transcript title scan (large transcripts). */
const TITLE_WINDOW = 128 * 1024;

/**
 * The session's own name from its transcript: the last explicit `agent-name`
 * (the user named it) if present, else the last generated `ai-title` — what
 * Claude Code's resume picker shows. Normalised to a single ≤80-char line;
 * null when absent (e.g. before the first exchange).
 *
 * Verified against Claude Code 2.1.210 (2026-07-14): the transcript carries
 * `{type:"ai-title", aiTitle}` shortly after the first exchange and, when the
 * session is named, `{type:"agent-name", agentName}`. A regenerated title is
 * appended, so the newest lives near the tail; the first lands early (~line
 * 15). We read a bounded tail window and fall back to the head only when a
 * since-grown transcript's tail holds no title line — so an early title is
 * never lost, and the read stays bounded regardless of file size.
 */
function readSessionTitle(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    let title = pickTitle(readTranscriptChunk(fd, Math.max(0, size - TITLE_WINDOW), TITLE_WINDOW));
    if (title === null && size > TITLE_WINDOW)
      title = pickTitle(readTranscriptChunk(fd, 0, TITLE_WINDOW));
    return title;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function readTranscriptChunk(fd: number, start: number, length: number): string {
  const buf = Buffer.allocUnsafe(length);
  const read = readSync(fd, buf, 0, length, start);
  return buf.toString('utf8', 0, read);
}

/** Newest agent-name (preferred) or ai-title in a transcript chunk, normalised. */
function pickTitle(text: string): string | null {
  let aiTitle: string | null = null;
  let agentName: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"ai-title"') && !line.includes('"agent-name"')) continue;
    try {
      const rec = JSON.parse(line) as { type?: string; aiTitle?: unknown; agentName?: unknown };
      if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') aiTitle = rec.aiTitle;
      else if (rec.type === 'agent-name' && typeof rec.agentName === 'string')
        agentName = rec.agentName;
    } catch {
      // Partial line at a window boundary — ignore.
    }
  }
  const raw = agentName ?? aiTitle;
  if (raw === null) return null;
  const norm = raw.trim().replace(/\s+/g, ' ').slice(0, 80);
  return norm === '' ? null : norm;
}

/** The conversation's cwd appears within the first few JSONL records. */
function conversationCwdMatches(path: string, matches: (cwd: string) => boolean): boolean {
  let head: string;
  try {
    head = readFileSync(path, 'utf8').slice(0, 16_384);
  } catch {
    return false;
  }
  for (const line of head.split('\n').slice(0, 10)) {
    try {
      const record = JSON.parse(line) as { cwd?: string };
      if (typeof record.cwd === 'string' && matches(record.cwd)) return true;
    } catch {
      // Partial trailing line inside the head window — ignore.
    }
  }
  return false;
}

interface ClaudeCatalogueCacheEntry {
  size: number;
  mtimeMs: number;
  conversation: import('../adapter.js').NativeConversation;
}

const claudeCatalogueCache = new Map<string, ClaudeCatalogueCacheEntry>();

/**
 * Account-wide Claude catalogue. Directory/stat work is asynchronous and an
 * unchanged transcript costs no reads; changed files use bounded head/tail
 * windows for cwd/title metadata only.
 */
async function discoverClaudeConversations(
  configDir: string,
): Promise<import('../adapter.js').NativeConversation[]> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const root = join(configDir, 'projects');
  const files: string[] = [];
  let projects: Dirent[];
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const project of projects) {
    if (!project.isDirectory() && !project.isSymbolicLink()) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, project.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.jsonl')) {
        files.push(join(root, project.name, entry.name));
      }
    }
  }
  const live = new Set(files);
  for (const path of claudeCatalogueCache.keys()) {
    if (!live.has(path)) claudeCatalogueCache.delete(path);
  }
  const out: import('../adapter.js').NativeConversation[] = [];
  for (let offset = 0; offset < files.length; offset += 32) {
    const batch = await Promise.all(files.slice(offset, offset + 32).map(readClaudeMetadata));
    for (const metadata of batch) if (metadata) out.push(metadata);
  }
  return out.sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''));
}

async function readClaudeMetadata(
  path: string,
): Promise<import('../adapter.js').NativeConversation | null> {
  try {
    const stats = await stat(path);
    const cached = claudeCatalogueCache.get(path);
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
      return cached.conversation;
    }
    const handle = await open(path, 'r');
    try {
      const headBuffer = Buffer.allocUnsafe(Math.min(16_384, Math.max(1, stats.size)));
      const { bytesRead } = await handle.read(headBuffer, 0, headBuffer.length, 0);
      const head = headBuffer.toString('utf8', 0, bytesRead);
      let cwd: string | null = null;
      for (const line of head.split('\n').slice(0, 20)) {
        try {
          const record = JSON.parse(line) as { cwd?: unknown };
          if (typeof record.cwd === 'string') {
            cwd = record.cwd;
            break;
          }
        } catch {
          /* partial boundary line */
        }
      }
      if (cwd === null) return null;
      const tailStart = Math.max(0, stats.size - TITLE_WINDOW);
      const tailBuffer = Buffer.allocUnsafe(Math.min(TITLE_WINDOW, Math.max(1, stats.size)));
      const tailRead = await handle.read(tailBuffer, 0, tailBuffer.length, tailStart);
      const tail = tailBuffer.toString('utf8', 0, tailRead.bytesRead);
      const conversation = {
        ref: basename(path, '.jsonl'),
        cwd,
        title: pickTitle(tail) ?? pickTitle(head),
        parentRef: null,
        createdAt: stats.birthtime.toISOString(),
        updatedAt: stats.mtime.toISOString(),
      } satisfies import('../adapter.js').NativeConversation;
      claudeCatalogueCache.set(path, { size: stats.size, mtimeMs: stats.mtimeMs, conversation });
      return conversation;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function addUsage(into: AgentUsage, more: AgentUsage): void {
  into.input_tokens += more.input_tokens;
  into.output_tokens += more.output_tokens;
  into.cache_read_input_tokens += more.cache_read_input_tokens;
  into.cache_creation_input_tokens += more.cache_creation_input_tokens;
  into.message_count += more.message_count;
}

/** Cached per-file token subtotal; reparses only when (size, mtime) changed. */
function fileUsage(path: string): AgentUsage {
  let stat: { size: number; mtimeMs: number };
  try {
    stat = statSync(path);
  } catch {
    return EMPTY_USAGE;
  }
  const cached = usageCache.get(path);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.usage;
  }
  const usage = { ...EMPTY_USAGE };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return EMPTY_USAGE;
  }
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    let record: { type?: string; message?: { usage?: Record<string, number> } };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue; // a partial trailing line from a live writer
    }
    if (record.type !== 'assistant') continue;
    const u = record.message?.usage;
    if (!u) continue;
    usage.message_count += 1;
    usage.input_tokens += u['input_tokens'] ?? 0;
    usage.output_tokens += u['output_tokens'] ?? 0;
    usage.cache_read_input_tokens += u['cache_read_input_tokens'] ?? 0;
    usage.cache_creation_input_tokens += u['cache_creation_input_tokens'] ?? 0;
  }
  usageCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, usage });
  return usage;
}

/**
 * The conversation as readable text for a cross-agent hand-off (SPEC §5).
 * User and assistant text only: thinking blocks are the agent's private
 * reasoning (tier 2 is "degraded by design") and tool payloads are bulky, so a
 * run of them collapses to a single count line.
 */
function renderTranscript(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  const out: string[] = [];
  let toolCalls = 0;
  const flushTools = () => {
    if (toolCalls > 0) out.push(`_(ran ${toolCalls} tool call${toolCalls === 1 ? '' : 's'})_`);
    toolCalls = 0;
  };
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    let record: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue; // a partial trailing line from a live writer
    }
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    const text = transcriptText(record.message?.content, () => toolCalls++);
    if (text === '') continue;
    flushTools();
    out.push(`## ${record.type === 'user' ? 'User' : 'Assistant'}\n\n${text}`);
  }
  flushTools();
  return out.join('\n\n');
}

/** Plain text of a message's content, counting tool uses via `onTool`. */
function transcriptText(content: unknown, onTool: () => void): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const { type, text } = block as { type?: string; text?: string };
    if (type === 'tool_use' || type === 'tool_result') onTool();
    else if (type === 'text' && typeof text === 'string' && text.trim() !== '') {
      parts.push(text.trim());
    }
    // 'thinking' / 'redacted_thinking' deliberately dropped.
  }
  return parts.join('\n\n');
}
