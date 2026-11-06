import type { Account, AgentTurnSignal } from '@puddle/shared';

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  message_count: number;
}

export interface SubscriptionUsageWindow {
  key: string;
  label: string;
  used_percentage: number;
  /** The agent's own reset phrasing ("Jul 20 at 4am"), shown verbatim. */
  resets: string | null;
}

export interface LiveUsage {
  /** ISO timestamp of the most recent capture. */
  captured_at: string;
  /** Current conversation's context-window fill, 0..100, or null pre-turn. */
  context_used_percentage: number | null;
  /** Session cost in USD (≈0 for subscription accounts — unmetered). */
  total_cost_usd: number | null;
  model: string | null;
}

export interface LaunchOpts {
  worktreePath: string;
  /** Puddle session uuid (adapters with presetSessionId reuse it as the agent's id). */
  sessionId: string;
  /** First prompt, already including any onboarding preamble. */
  prompt?: string;
  skipPermissions: boolean;
}

export interface StatusPatterns {
  waitingInput: RegExp[];
  busy?: RegExp[];
  limitReached?: RegExp[];
}

export interface SessionRefContext {
  /** Puddle session identity; distinct from the agent-native ref. */
  sessionId: string;
  worktreePath: string;
  /** When the puddle session row was created. */
  createdAt: string;
  /**
   * When the linked native conversation was created, when its catalogue
   * metadata records that independently from the later placement row.
   */
  nativeCreatedAt?: string;
  /** Agent-native refs already owned by another session or present before launch. */
  excludeRefs?: ReadonlySet<string>;
}

/** Storage inspection may yield so large agent histories never block puddled. */
export type StorageLookup<T> = T | Promise<T>;

/** Normalised, credential-free metadata returned by a native store scan. */
export interface NativeConversation {
  ref: string;
  cwd: string;
  title: string | null;
  parentRef: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ConversationDiscoveryHooks {
  /** Store roots whose metadata changes should schedule a debounced scan. */
  watchRoots(account: Account): string[];
  /** Full top-level catalogue; never reads transcript bodies. */
  discover(account: Account): Promise<NativeConversation[]>;
}

export interface LifecycleLaunchResource {
  /** Optional adapter-owned terminal driver for structured execution. */
  binary?: string;
  /** Optional exact message/reply control; never infer replies from PTY quietness. */
  control?: AgentControl;
  /** Replacement CLI arguments (for example Codex's `--remote` transport). */
  args: string[];
  /** Sidecar process roots included in runtime port/process ownership. */
  sidecarPids?: number[];
  /** Internal bridge ports excluded from the user-facing port catalogue. */
  hiddenPorts?: number[];
  dispose(): void | Promise<void>;
}

export interface AgentControl {
  readonly ready: boolean;
  ask(prompt: string, signal: AbortSignal, outputSchema?: Record<string, unknown>): Promise<string>;
  signal?(event: AgentTurnSignal): 'working' | 'waiting_input' | undefined;
  lifecycle?(ref: string | undefined, ended: boolean): void;
  input?(): void;
}

export interface LifecycleLaunchContext {
  account: Account;
  opts: LaunchOpts;
  args: string[];
  signalUrl: string;
  signalNonce: string;
  /** Exact resume identity, never a catalogue guess. */
  resumeRef?: string;
  /** Captured session environment; the adapter's own isolation still wins. */
  env?: Record<string, string>;
  /** Write only to this stable runtime's main terminal. */
  writeInput?(data: string): void;
  /** Exact native identity/status from a structured execution resource. */
  bindConversation?(ref: string): Promise<void>;
  reportStatus?(state: 'working' | 'waiting_input'): void;
  /**
   * A stop a launch that failed leaves running (its sidecar's, which on
   * Windows reads the process table first): daemon shutdown waits for it,
   * within the bound it gives lifecycle disposals. Never rejects.
   */
  trackStop?(stop: Promise<void>): void;
}

export interface ConversationShareHooks {
  /**
   * Directory under the account's config dir that CONTAINS the per-conversation
   * store dirs (e.g. `<config>/projects`). The canonical store's symlinks are
   * placed here, one per store-key.
   */
  storeParent(account: Account): string;
  /**
   * The store dir holding `<ref>`'s conversation under this account, or null.
   * Found by following the filesystem (so it resolves a post-adoption symlink
   * too); the caller distinguishes real from symlink via lstat. The store-key
   * is the basename of the returned path.
   */
  locateStoreDir(ref: string, account: Account): string | null;
  /**
   * The session's own files, split by ownership: `inStore` paths live INSIDE
   * the (canonical) store dir and are shared across accounts; `perAccount`
   * paths are ancillary state kept under each account's config dir (todos etc.)
   * and exist once per account.
   */
  sessionFiles(
    ref: string,
    storeDir: string,
    account: Account,
  ): { inStore: string[]; perAccount: string[] };
}

/**
 * One adapter per coding agent (SPEC §5). ALL agent-specific behaviour —
 * flags, env vars, session-file locations, status regexes — lives in the
 * adapter; core session logic stays agent-agnostic.
 */
export interface AgentAdapter {
  /** Supports exact automated turns through its lifecycle resource. */
  scriptedTurns?: boolean;
  id: string;
  displayName: string;
  /** Executable name resolved on PATH. */
  binary: string;
  /** Recognise this agent's foreground executable/entry point; transient icon and completion observation only. */
  matchesProcess?(command: string): boolean;
  capabilities: {
    resume: boolean;
    presetSessionId: boolean;
    skipPermissions: boolean;
    migratableSessions: boolean;
  };
  /** Config-dir isolation env for a puddle-managed account. */
  env(account: Account): Record<string, string>;
  /**
   * Records the agent's one-time skip-permissions acceptance in the account's
   * config dir. Called only when the user opens the profile skip-permissions
   * gate in the UI (SPEC §11) — that confirmation is the human consent. For
   * Claude Code this is the dangerous-mode disclaimer, which otherwise silently
   * downgrades `--dangerously-skip-permissions` to normal prompts in a
   * non-interactive PTY. Absent → the agent has no such acceptance gate.
   */
  acceptSkipPermissions?(account: Account): void;
  /**
   * One-off seeding of a freshly created (empty) config dir, before any
   * login or session runs — e.g. marking the agent's first-run onboarding
   * complete so it never hijacks a puddle session with its setup wizard.
   */
  prepareConfigDir?(configDir: string): void;
  /**
   * Whether the account still holds the conversation `ref` resumes. Checked
   * before spawning a resume so a missing conversation is a clean 409, not
   * an agent process dying on launch.
   */
  hasConversation?(ref: string, account: Account): StorageLookup<boolean>;
  /**
   * Imports a pre-existing config dir by COPYING it into the puddle-owned
   * `configDir` (already created, empty) — the source is read once and never
   * touched again. Implementations also apply their prepareConfigDir seeding.
   */
  importConfigDir?(sourceDir: string, configDir: string): Promise<void>;
  /**
   * Asks the agent whether the account is currently authenticated (e.g. after
   * an import, where credentials may be keychain-bound and not travel with
   * the copied files). Never surfaces credential material — a boolean only.
   * Also consulted before create/resume: a stale logged-in flag otherwise
   * lets the agent's own login screen hijack the session (and its preset id).
   */
  checkLoggedIn?(account: Account): Promise<boolean>;
  /**
   * Agent-native refs already present for this working directory. Adapters that
   * mint their own ids expose this snapshot so a new launch cannot mistake an
   * older conversation for the one it just created.
   */
  existingSessionRefs?(worktreePath: string, account: Account): StorageLookup<ReadonlySet<string>>;
  /**
   * Recovers the conversation ref for a worktree when the recorded one
   * matches nothing, is duplicated, or does not belong to this puddle session.
   * `context.createdAt` lets minted-id adapters recover the conversation born
   * for this session instead of guessing the newest conversation in the cwd.
   */
  discoverSessionRef?(
    worktreePath: string,
    account: Account,
    context?: SessionRefContext,
  ): StorageLookup<string | null>;
  /**
   * Whether `ref` belongs to this puddle session, not merely whether the agent
   * can read it. Minted-id adapters validate cwd + creation time here so a
   * stale but real conversation cannot silently replace another session.
   */
  sessionRefMatches?(
    ref: string,
    context: SessionRefContext,
    account: Account,
  ): StorageLookup<boolean>;
  /**
   * The agent's own human-readable session name for conversation `ref` — for
   * Claude Code, the transcript's agent-name / ai-title, i.e. what its resume
   * picker shows. Null when the agent has not named the session yet. Read-only
   * and credential-free; the daemon uses it as the default display name before
   * any user rename (SPEC §4).
   */
  sessionTitle?(ref: string, account: Account): string | null;
  /** Bounded, exact-conversation last assistant reply for an attention preview. */
  notificationOutput?(ref: string, account: Account): Promise<string | null>;
  /**
   * When the agent last recorded real work for conversation `ref` — for
   * Claude Code, the transcript's mtime (a cached stat). Distinct from PTY
   * activity: a wedged TUI can redraw forever without ever writing its
   * transcript. Null when unknown; the daemon uses it to compute the advisory
   * `stale_running` flag (SPEC §4) and never interrupts an agent over it.
   */
  sessionActivityAt?(ref: string, account: Account): Date | null;
  /**
   * Token usage the agent recorded for this account, summed from its own
   * on-disk history. Best-effort and non-authoritative (not billing data);
   * null when the agent keeps no readable record.
   */
  usageStats?(account: Account): AgentUsage | null;
  /**
   * The most recent live-session usage the agent emitted (context-window
   * fill, cost). Credential-free; null when nothing has been captured yet.
   */
  liveUsage?(account: Account): LiveUsage | null;
  /**
   * Subscription rate-limit windows (the `/usage` view), asked of the agent's
   * own CLI — credential-free, fetched for any logged-in account. Fails safe
   * to null (missing binary, timeout, unrecognised output).
   */
  subscriptionUsage?(account: Account): Promise<SubscriptionUsageWindow[] | null>;
  /**
   * Idempotent config-dir upkeep run once per account at boot — brings older
   * accounts up to date with setup that newer versions seed at create time
   * (e.g. the live-usage status line). Must never overwrite user data.
   */
  reconcileConfigDir?(account: Account): void;
  launchArgs(opts: LaunchOpts): string[];
  resumeArgs(ref: string, opts: LaunchOpts): string[];
  loginArgs(): string[];
  /**
   * Guidance the login dialogue shows verbatim (protocol 13.1) — for a login
   * flow that is not self-evidently finishable, e.g. a full TUI that sits in
   * a REPL after sign-in and must be exited by hand.
   */
  loginHint?: string;
  /**
   * Agent-native session ref: echoes a preset id or discovers it post-launch.
   * Minted-id discovery runs behind the session-create response; returning the
   * puddle session id means "not visible yet" and is never stored as native.
   */
  resolveSessionRef(
    opts: LaunchOpts,
    account: Account,
    excludeRefs?: ReadonlySet<string>,
  ): Promise<string>;
  /** Matched against ANSI-stripped output (SPEC §5). */
  statusPatterns: StatusPatterns;
  /**
   * Shared conversation store hooks (Workstream S). Present only for agents
   * whose conversations live in per-conversation directories that can be
   * adopted into a per-profile canonical store and symlinked into every
   * account of the (profile, agent). Absent → the manager treats the agent as
   * non-shareable and does nothing. All paths returned are absolute.
   */
  conversationShare?: ConversationShareHooks;
  /** Native conversation catalogue metadata and watch roots (SPEC §5). */
  conversationDiscovery?: ConversationDiscoveryHooks;
  /** The adapter has an exact lifecycle channel over the nonce-gated signal route. */
  lifecycleSignals?: boolean;
  /** Per-launch installed-version capability probe for hook/plugin channels. */
  checkLifecycleSupport?(account: Account): Promise<boolean>;
  /** Per-runtime exact lifecycle transport (Codex app-server bridge). */
  prepareLifecycleLaunch?(context: LifecycleLaunchContext): Promise<LifecycleLaunchResource>;
  /** Structured execution with a readable transcript instead of a native TUI. */
  prepareHeadlessLaunch?(context: LifecycleLaunchContext): Promise<LifecycleLaunchResource>;
  /** Phase 7: move conversation state between accounts (same agent). */
  migrateSession?(ref: string, from: Account, to: Account, worktree: string): Promise<void>;
  /** Phase 7: render the conversation as text for cross-agent hand-off. */
  exportTranscript?(ref: string, account: Account, worktree: string): Promise<string>;
}
