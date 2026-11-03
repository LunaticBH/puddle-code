import { prepareCodexHeadless } from './headless.js';
import { statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { AgentAdapter } from '../adapter.js';
import { agentEnv, execAgent } from '../agent-process.js';
import { matchesAgentProcess } from '../process-match.js';
import {
  allRollouts,
  cachedRolloutPath,
  renderRollout,
  rolloutForRef,
  rolloutsFor,
} from './rollout.js';
import { codexThread, codexThreadIndex, threadTitle } from './threads.js';
import { prepareCodexLifecycle } from './lifecycle.js';
import { lastJsonlOutput } from '../notification-output.js';

const SESSION_START_WINDOW_MS = 5 * 60 * 1000;

/**
 * Codex adapter.
 *
 * Flags and storage re-verified against codex-cli 0.147.0 (2026-08-12),
 * `--help` plus live rollout metadata:
 * - `CODEX_HOME` relocates config, sessions and credentials together (verified:
 *   the CLI warns when the path is missing and creates its `tmp/` there). One
 *   variable is enough, unlike opencode.
 * - `--dangerously-bypass-approvals-and-sandbox` is the skip-permissions flag.
 *   **`--yolo` does NOT exist in 0.147.0** despite appearing in older docs;
 *   only the long form is accepted. `resume` accepts the flag too, so it is
 *   passed on both paths — but openai/codex#9144 reports it is not always
 *   HONOURED on resume, which is a runtime check (see docs/acceptance).
 * - `codex resume [SESSION_ID] [PROMPT]` — both positional; also `--last`,
 *   `--all`. Flags are emitted before the positionals.
 * - Login runs the bare TUI (see loginArgs); `codex login status` **exits 1
 *   when logged out** (verified) and 0 when logged in, so the exit code alone
 *   drives checkLoggedIn — no output parsing. `codex login` was used through
 *   v0.0.31 but starts the browser OAuth flow and its localhost callback
 *   server ON THE DAEMON HOST while rendering nothing in the PTY — from a
 *   remote cockpit the login dialogue was an empty terminal.
 * - Session ids are NOT presettable: codex mints its own rollout id, so
 *   `presetSessionId: false` and `agent_session_ref !== sessions.id` — the
 *   first adapter where those diverge. resolveSessionRef polls in the
 *   background for the state index, excluding every top-level ref present
 *   before launch, so session creation never waits for the poll. The
 *   index is the primary source because it appears before a large rollout's
 *   first JSONL line is readable; rollout scanning is the compatibility
 *   fallback. Codex also writes sub-agent rows/rollouts with the same cwd;
 *   `thread_source` / `parent_thread_id` excludes those.
 * - Rollouts live at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
 *   (verified against real files). Line 1 is a `session_meta` record whose
 *   payload carries `id` and **`cwd`** — the field conversation lookup matches.
 *
 * - Session NAMES live in `$CODEX_HOME/state_<n>.sqlite` (`threads.name`), not in
 *   the rollout — see codex-threads.ts. Without reading it a codex session has
 *   no `agent_title` at all and falls back to the terminal title, which codex
 *   sets to the working directory's basename, so every session in a repo showed
 *   the same static name and a rename never appeared.
 *
 * - Windows (from codex-rs source, not run live: no Codex was installed on the
 *   port machine): `CODEX_HOME` relocates state as above (default
 *   `%USERPROFILE%\.codex`). Rollout cwds may carry Rust's `\\?\` prefix,
 *   so cwds are compared through sameNativeCwd, and the npm launcher's native
 *   app-server is stopped as a process tree.
 *
 * No `conversationShare`: rollouts are date-bucketed files, not per-conversation
 * directories, so the Workstream S store model does not apply and
 * `migratableSessions` is false (tier-1 migration returns the documented
 * `409 migration_unsupported`; tier-2 hand-off still works).
 */
export const codex: AgentAdapter = {
  scriptedTurns: true,
  prepareHeadlessLaunch: prepareCodexHeadless,
  id: 'codex',
  displayName: 'Codex',
  binary: 'codex',
  matchesProcess: (command) =>
    matchesAgentProcess(command, 'codex', ['@openai/codex/bin/codex.js']),
  capabilities: {
    resume: true,
    presetSessionId: false,
    skipPermissions: true,
    migratableSessions: false,
  },

  env(account) {
    // Codex 0.157.1 (live copy probe): outside tmux, native clipboard success
    // skips OSC 52 unless SSH_TTY or SSH_CONNECTION is present. A supervised
    // daemon normally has neither, even when its viewers connect over SSH.
    // Mark this browser-backed TUI as remote-capable so copies also reach the
    // viewing terminal. An empty presence-only marker invents no SSH endpoint
    // or tty path; preserve an actual inherited SSH_TTY when one exists.
    // The separate lifecycle app-server does not receive this marker.
    return { CODEX_HOME: account.config_dir, SSH_TTY: process.env['SSH_TTY'] ?? '' };
  },

  launchArgs(opts) {
    return [
      ...(opts.skipPermissions ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
      ...(opts.prompt !== undefined ? [opts.prompt] : []),
    ];
  },

  resumeArgs(ref, opts) {
    // `resume [SESSION_ID] [PROMPT]`: flags first, then the positionals in order.
    return [
      'resume',
      ...(opts.skipPermissions ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
      ref,
      ...(opts.prompt !== undefined ? [opts.prompt] : []),
    ];
  },

  loginArgs() {
    // The bare TUI, not `codex login` (decision 2026-08-06, matching the
    // claude-code login): an unauthenticated bare `codex` renders its own
    // sign-in screen IN the PTY (ChatGPT sign-in or API key), where `codex
    // login` only opened a browser + callback server on the daemon host and
    // showed nothing — an empty login dialogue from any remote cockpit. The
    // clean exit is verified via `login status` (accounts route), never
    // assumed. Confirm the first-run screen against a live codex in the
    // Phase 7 acceptance run.
    return [];
  },
  loginHint:
    'Pick a sign-in method on Codex’s own screen. When you are done, press Ctrl+C twice to close the agent and finish.',

  async checkLoggedIn(account) {
    try {
      // Exits 0 logged in, 1 logged out (verified 0.146.0). execFile rejects on
      // a non-zero exit, so reaching the return means authenticated.
      await execAgent('codex', ['login', 'status'], {
        env: agentEnv({ CODEX_HOME: account.config_dir }),
        timeout: 15_000,
      });
      return true;
    } catch {
      return false; // logged out / timeout / unexpected failure
    }
  },

  async existingSessionRefs(worktreePath, account) {
    return new Set(
      (await codexSessionsFor(account.config_dir, worktreePath)).map((meta) => meta.id),
    );
  },

  async resolveSessionRef(opts, account, excludeRefs = new Set()) {
    // The state row normally appears before session_meta is readable. Keep a
    // bounded fallback wait for older schemas/index failures; the coordinator
    // does not persist the unresolved puddle-id placeholder and retries safely
    // on status/title refreshes (with resume recovery as the final backstop).
    const launchedAt = new Date().toISOString();
    const deadline = Date.now() + 10_000;
    for (;;) {
      const ref = (await codexSessionsFor(account.config_dir, opts.worktreePath)).find(
        (session) => !excludeRefs.has(session.id),
      )?.id;
      if (ref !== undefined) return ref;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // A readable but stale/partial state index is unusual; make one asynchronous
    // rollout fallback attempt at the deadline before leaving capture late.
    const fallback = rolloutBornFor(
      (await codexSessionsFor(account.config_dir, opts.worktreePath, true)).filter(
        (session) => !excludeRefs.has(session.id),
      ),
      launchedAt,
    );
    if (fallback !== undefined) return fallback.id;
    // Placeholder: hasConversation() reports it missing, so resume recovers the
    // real ref through discoverSessionRef rather than failing outright.
    return opts.sessionId;
  },

  async discoverSessionRef(worktreePath, account, context) {
    const createdAt = context?.nativeCreatedAt ?? context?.createdAt;
    let candidates = (await codexSessionsFor(account.config_dir, worktreePath)).filter(
      (meta) => !context?.excludeRefs?.has(meta.id),
    );
    let match = createdAt === undefined ? candidates[0] : rolloutBornFor(candidates, createdAt);
    if (match !== undefined) return match.id;
    candidates = (await codexSessionsFor(account.config_dir, worktreePath, true)).filter(
      (meta) => !context?.excludeRefs?.has(meta.id),
    );
    match = createdAt === undefined ? candidates[0] : rolloutBornFor(candidates, createdAt);
    if (match !== undefined) return match.id;
    if (context === undefined) return null;
    const recoveryCreatedAt = context.nativeCreatedAt ?? context.createdAt;

    // Compatibility for sessions born during the v0.0.56 remote-bridge cwd
    // regression. Their thread is real but recorded under the daemon cwd, so
    // a worktree-scoped recovery can never find it. Creation-time uniqueness
    // plus other-session exclusions make the account-wide fallback as safe as
    // the normal recovery path; ambiguity still refuses rather than guessing.
    const accountCandidates = (await accountWideCodexSessions(account.config_dir)).filter(
      (candidate) => !context.excludeRefs?.has(candidate.id),
    );
    return rolloutBornFor(accountCandidates, recoveryCreatedAt)?.id ?? null;
  },

  async sessionRefMatches(ref, context, account) {
    const createdAt = context.nativeCreatedAt ?? context.createdAt;
    const indexed = (await codexSessionsFor(account.config_dir, context.worktreePath)).filter(
      (candidate) => !context.excludeRefs?.has(candidate.id),
    );
    const indexedMatch = rolloutBornFor(indexed, createdAt);
    if (indexedMatch !== undefined) return indexedMatch.id === ref;
    const rolloutMatch =
      rolloutBornFor(
        (await codexSessionsFor(account.config_dir, context.worktreePath, true)).filter(
          (candidate) => !context.excludeRefs?.has(candidate.id),
        ),
        createdAt,
      )?.id ?? null;
    if (rolloutMatch !== null) return rolloutMatch === ref;

    // Compatibility for the v0.0.56 lifecycle-bridge regression: app-server
    // inherited the daemon cwd, so an exact lifecycle UUID could be recorded
    // under `~` rather than this Puddle worktree. Keep the same ambiguity guard
    // as ordinary recovery, but search the account-wide top-level index when
    // the cwd-scoped lookup has no candidate. This cannot guess between two
    // concurrent launches inside the 15 s uniqueness window.
    const accountCandidates = await accountWideCodexSessions(account.config_dir);
    return (
      rolloutBornFor(
        accountCandidates.filter((candidate) => !context.excludeRefs?.has(candidate.id)),
        createdAt,
      )?.id === ref
    );
  },

  async hasConversation(ref, account) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const indexed = codexThread(account.config_dir, ref);
    if (indexed !== null) {
      try {
        await stat(indexed.rolloutPath);
        return true;
      } catch {
        // A stale path falls through to the compatibility index.
      }
    }
    return (await rolloutForRef(account.config_dir, ref)) !== null;
  },

  sessionTitle(ref, account) {
    return threadTitle(account.config_dir, ref);
  },

  async notificationOutput(ref, account) {
    const path =
      codexThread(account.config_dir, ref)?.rolloutPath ??
      cachedRolloutPath(account.config_dir, ref);
    if (!path) return null;
    return lastJsonlOutput(path, (record) => {
      const payload = record.payload as
        | {
            type?: string;
            message?: string;
            role?: string;
            channel?: string;
            content?: { type?: string; text?: string }[];
          }
        | undefined;
      if (record.type === 'event_msg' && payload?.type === 'user_message') return null;
      if (record.type === 'response_item' && payload?.type === 'message' && payload.role === 'user')
        return null;
      if (
        record.type === 'event_msg' &&
        payload?.type === 'agent_message' &&
        typeof payload.message === 'string'
      )
        return payload.message;
      if (
        record.type === 'response_item' &&
        payload?.type === 'message' &&
        payload.role === 'assistant' &&
        payload.channel !== 'analysis'
      ) {
        const text = payload.content
          ?.filter((part) => part.type === 'output_text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n');
        if (text) return text;
      }
      return undefined;
    });
  },

  sessionActivityAt(ref, account) {
    // The three-second computed-status path must never enumerate the account's
    // rollout tree. Codex's id index supplies the exact path in one keyed row.
    const path =
      codexThread(account.config_dir, ref)?.rolloutPath ??
      cachedRolloutPath(account.config_dir, ref);
    if (path === null) return null;
    try {
      return statSync(path).mtime;
    } catch {
      return null;
    }
  },

  async exportTranscript(ref, account) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const indexed = codexThread(account.config_dir, ref);
    if (indexed !== null) return renderRollout(indexed.rolloutPath);
    const rollout = await rolloutForRef(account.config_dir, ref);
    if (rollout === null) return '';
    return renderRollout(rollout.path);
  },

  conversationDiscovery: {
    watchRoots: (account) => [account.config_dir],
    discover: async (account) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const indexed = codexThreadIndex(account.config_dir);
      const rollouts = await allRollouts(account.config_dir);
      const parentById = new Map(rollouts.map((meta) => [meta.id, meta.parentThreadId]));
      // The current state DB can omit an older rollout until Codex opens it
      // through /resume. Always merge top-level rollout metadata instead of
      // treating an available DB as exhaustive, or the catalogue marks a real
      // Puddle conversation missing and hides its Resume action.
      const indexedIds = new Set(indexed.threads.map((thread) => thread.id));
      const rows = [
        ...indexed.threads,
        ...rollouts
          .filter((meta) => meta.parentThreadId === null && !indexedIds.has(meta.id))
          .map((meta) => ({
            id: meta.id,
            cwd: meta.cwd,
            createdAt: meta.createdAt,
            rolloutPath: cachedRolloutPath(account.config_dir, meta.id) ?? '',
            title: null,
          })),
      ];
      return rows.map((thread) => ({
        ref: thread.id,
        cwd: thread.cwd,
        title: thread.title,
        parentRef: parentById.get(thread.id) ?? null,
        createdAt: thread.createdAt === null ? null : new Date(thread.createdAt).toISOString(),
        updatedAt: (() => {
          try {
            return statSync(thread.rolloutPath).mtime.toISOString();
          } catch {
            return null;
          }
        })(),
      }));
    },
  },

  prepareLifecycleLaunch: prepareCodexLifecycle,

  /**
   * Verified against a live 0.146.0 PTY (2026-08-03): a screen redraw places
   * the `›` composer before the `<model> · <directory>` footer in the stripped
   * stream; the previously guessed "? for shortcuts" string never appears.
   * Native app-server turns drive status when available (lifecycle.ts);
   * these patterns remain the fallback and support manually launched terminals.
   */
  statusPatterns: {
    waitingInput: [/›[^›\r\n]{0,1000}\s·\s/],
    busy: [/to interrupt/i],
    limitReached: [/you've (hit|reached) your usage limit/i],
  },
};

/** Codex state-index rows first, with one explicit rollout fallback when needed. */
async function codexSessionsFor(
  configDir: string,
  worktreePath: string,
  includeFallback = false,
): Promise<Array<{ id: string; cwd: string; createdAt: number | null }>> {
  // `launchAndCapture` starts in a promise microtask; yielding a real event-loop
  // turn here lets the HTTP create response flush before even the SQLite probe.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const indexed = codexThreadIndex(configDir, worktreePath);
  if (indexed.available && !includeFallback) return indexed.threads;
  const seen = new Set(indexed.threads.map((thread) => thread.id));
  return [
    ...indexed.threads,
    ...(await rolloutsFor(configDir, worktreePath)).filter((rollout) => !seen.has(rollout.id)),
  ];
}

/**
 * Every top-level thread known anywhere in the account. Merge rather than pick
 * the state DB OR rollouts: Codex can leave an older rollout out of its current
 * state index until the user opens it through the native /resume picker.
 */
async function accountWideCodexSessions(
  configDir: string,
): Promise<Array<{ id: string; cwd: string; createdAt: number | null }>> {
  const indexed = codexThreadIndex(configDir).threads;
  const rollouts = (await allRollouts(configDir)).filter((meta) => meta.parentThreadId === null);
  const byId = new Map(
    rollouts.map((rollout) => [
      rollout.id,
      { id: rollout.id, cwd: rollout.cwd, createdAt: rollout.createdAt },
    ]),
  );
  for (const thread of indexed) {
    const rollout = byId.get(thread.id);
    byId.set(thread.id, {
      id: thread.id,
      cwd: thread.cwd,
      createdAt: thread.createdAt ?? rollout?.createdAt ?? null,
    });
  }
  return [...byId.values()];
}

/** Closest rollout born just after the puddle session row. */
function rolloutBornFor<T extends { createdAt: number | null }>(
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
