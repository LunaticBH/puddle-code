import { RuntimePersistence } from '../storage/runtime-persistence.js';
import type { StorageMonitor } from '../storage/monitor.js';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  Account,
  AgentNotification,
  AgentSignalRequest,
  AgentTurnSignal,
  ClearSessionEnvResponse,
  CreateSessionRequest,
  Session,
  SessionEnvResponse,
  SessionStatus,
} from '@puddle/shared';
import type { AgentAdapter, LaunchOpts, LifecycleLaunchResource } from '../agents/adapter.js';
import { assertBinaryAvailable } from '../agents/binary.js';
import type { AdapterRegistry } from '../agents/registry.js';
import type { AccountStore } from '../db/stores/accounts.js';
import type { ConversationStore } from '../db/stores/conversations.js';
import type { EventStore } from '../db/stores/events.js';
import type { ProfileStore } from '../db/stores/profiles.js';
import type { ProjectStore } from '../db/stores/projects.js';
import type { RepoStore } from '../db/stores/repos.js';
import type { SessionStore } from '../db/stores/sessions.js';
import { KeyedMutex } from '../git/mutex.js';
import { ApiError } from '../http/errors.js';
import { containedPath } from '../http/routes/worktree-shared.js';
import type { LogStore } from '../logs/log-store.js';
import { extractOscTitle, stripAnsi } from '../pty/ansi.js';
import type {
  PtyDataEvent,
  PtyCwdEvent,
  PtyEnvDeltaEvent,
  PtyExitEvent,
  PtyManager,
} from '../pty/pty-manager.js';
import { isDeniedEnvName, type ShellHooks } from '../pty/shell-hooks.js';
import { StatusDetector, type DetectedStatus } from '../pty/status-detector.js';
import type { CreateWorktreeResult, WorktreeManager } from '../worktrees/manager.js';
import type { ConversationShare } from './conversation-share.js';
import { buildHandoffPrompt } from './handoff.js';
import { terminalCommandArgs, type TerminalCommand } from './terminal-command.js';
import {
  buildConcurrentWorktreeNote,
  buildInterruptedResumeNote,
  buildOnboardingPreamble,
} from './onboarding.js';
import type { MarkerFileSync } from './onboarding.js';
import { SessionRefs } from './session-refs.js';
import { TerminalAgentMonitor } from './terminal-agent-monitor.js';
import { notificationContent } from './notification-content.js';

export interface SessionServiceDeps {
  storage?: StorageMonitor;
  storagePaths?: string[];
  profiles: ProfileStore;
  accounts: AccountStore;
  repos: RepoStore;
  projects: ProjectStore;
  sessions: SessionStore;
  conversations: ConversationStore;
  events: EventStore;
  worktrees: WorktreeManager;
  ptys: PtyManager;
  adapters: AdapterRegistry;
  logs: LogStore;
  onboarding: MarkerFileSync;
  /** Shared conversation store (Workstream S); absent → no adoption. */
  share?: ConversationShare;
  /** Session shell hooks (SPEC §4); absent → no cwd hook, history still isolated via env. */
  shellHooks?: ShellHooks;
  /** waiting_input quiet window; overridable for tests. */
  statusQuietMs?: number;
  /** Periodic agent-name re-read interval; overridable for tests. */
  titleRefreshMs?: number;
}

export interface StatusEvent {
  session: string;
  status: SessionStatus;
  last_activity_at: string | null;
}

/** A failure the user must see, relayed to every client as a toast (SPEC §4). */
export interface NoticeEvent {
  level: 'error' | 'warning';
  title: string;
  detail?: string;
  session?: string;
  term?: string;
}

export interface RenameEvent {
  session: string;
  /** User override (null → use agent_title, then osc_title, then the id prefix). */
  title: string | null;
  /** The agent's own name; carried so a live agent-title change updates the default. */
  agent_title: string | null;
  /** The terminal-title "sequence" name; carried so a live change updates the default. */
  osc_title?: string | null;
}

export type LifecycleSignal = Extract<
  AgentSignalRequest,
  { event: 'session_start' | 'session_end' }
>;

export interface SessionSwitchEvent {
  sourceSession: string;
  targetSession: string;
  targetProject: string;
  cause: 'clear' | 'resume' | 'fork';
  outcome: 'rebound' | 'focused-existing';
}

interface LiveAgent {
  /** Stable identity for the process tree, independent of its active placement. */
  runtimeId: string;
  activeSessionId: string;
  conversationId: number | null;
  lifecycleResource: LifecycleLaunchResource | null;
  /** Null for terminal sessions — a plain shell has no status detector. */
  detector: StatusDetector | null;
  /** When this PTY was spawned, to tell a failed launch from a later crash. */
  startedAt: number;
  status: Extract<SessionStatus, 'starting' | 'running' | 'waiting_input'>;
  lastTouch: number;
  /** Throttle for the OSC-title-driven agent-name re-read (see onPtyData). */
  lastTitleCheck: number;
  /** Last OSC "sequence" title seen, to persist/broadcast only on a real change. */
  lastOscTitle: string | null;
  /** Per-spawn secret for /agent-signal (SPEC §4); null for shells. */
  signalNonce: string | null;
  /**
   * True once a hook signal arrived: from then on the agent's own hooks are
   * authoritative for running ⇄ waiting_input and the regex detector is
   * ignored (TUI redraws would otherwise flap an idle session back to
   * running with no hook event to restore it).
   */
  signalled: boolean;
}

const LIVE_STATUSES: SessionStatus[] = ['starting', 'running', 'waiting_input'];

// How often to re-read each live agent's own session name. A rename made INSIDE
// the agent (e.g. Claude Code's `/rename`) is a client-side transcript edit that
// triggers no status change and — while the session sits idle — no terminal-title
// escape either, so the event-driven refreshes (status change, OSC title, exit)
// all miss it. Cheap per tick: adapter.sessionTitle is a cached stat that
// early-returns while the transcript's (size, mtime) are unchanged.
const TITLE_REFRESH_MS = 3000;

// A `running` agent whose transcript has been quiet this long is flagged
// `stale_running` (computed on read, like worktree_missing) — probably a
// wedged agent process. Advisory only: a genuinely long tool call looks the
// same, so the daemon must never kill or downgrade the session itself.
const STALE_RUNNING_MS = 60 * 60 * 1000;

// An agent dying this soon after spawn failed to START — a rejected flag, a
// missing credential — rather than crashing mid-work. The status is no use for
// telling these apart: a launch error printed to the terminal is output like
// any other, so it flips the session to `running` on its way out.
const STARTUP_FAILURE_MS = 5000;

// Captured-env caps (SPEC §4), enforced daemon-side regardless of what the
// shell hook reports. Oversized values and overflow names are dropped with a
// one-time [puddle] note in the reporting terminal.
const MAX_ENV_VALUE_BYTES = 32 * 1024;
const MAX_ENV_VARS = 128;

/**
 * Orchestrates the session state machine (SPEC §4). SQLite rows are the
 * durable truth; `liveAgents` tracks the in-memory attachment (detector +
 * cached status) for each live agent PTY. Emits 'status' (StatusEvent) and
 * 'renamed' (RenameEvent).
 */
export class SessionService extends EventEmitter {
  /** Resolve current placement through stable runtime ownership for puddlang. */
  scriptRuntime(reference: string) {
    const live = this.runtimes.get(reference) ?? this.liveAgents.get(reference);
    if (!live) throw ApiError.conflict('agent_not_live', 'The agent has no live runtime');
    const control = live.lifecycleResource?.control;
    if (!control)
      throw ApiError.conflict(
        'scripted_turns_unavailable',
        'This runtime has no exact automated-turn channel; use a supported agent with full native synchronisation',
      );
    return {
      handle: { runtime_id: live.runtimeId, session_id: live.activeSessionId },
      session: this.get(live.activeSessionId),
      control,
    };
  }
  private readonly liveAgents = new Map<string, LiveAgent>();
  /** nonce → session id for /agent-signal lookups; entries die with the PTY. */
  private readonly signalNonces = new Map<string, LiveAgent>();
  /** Stable runtime registry and the one-live-runtime-per-conversation index. */
  private readonly runtimes = new Map<string, LiveAgent>();
  private readonly conversationRuntimes = new Map<number, LiveAgent>();
  private readonly lifecycleMutex = new KeyedMutex();
  /** The daemon's bound port, once known — enables the signal env injection. */
  private signalPort: number | null = null;
  /** Sessions whose conversation is already adopted — stops the retry loop. */
  private readonly adopted = new Set<string>();
  /**
   * Streams (or `${stream}:${term}` pairs) being stopped on purpose, so their
   * non-zero exit raises no notice. Entries are consumed by the matching exit.
   */
  private readonly expectedExits = new Set<string>();
  /** `${sessionId}:${name}` pairs already warned about, so cap notes fire once. */
  private readonly envDropNoted = new Set<string>();
  private readonly sessionRefs: SessionRefs;
  private shuttingDown = false;
  private readonly titleTimer: ReturnType<typeof setInterval>;
  private readonly terminalAgents: TerminalAgentMonitor;
  private readonly persistence: RuntimePersistence;
  private lastPersistenceRetry = 0;

  constructor(private readonly deps: SessionServiceDeps) {
    super();
    this.persistence = new RuntimePersistence(deps.sessions, deps.events, deps.storage);
    this.sessionRefs = new SessionRefs(deps);
    this.terminalAgents = new TerminalAgentMonitor({
      adapters: deps.adapters.list(),
      quietMs: deps.statusQuietMs,
      notify: (session, reason) =>
        this.persistence.observe(() => this.notifyAgent(session, reason)),
      targets: () =>
        [...this.liveAgents.values()].flatMap((live) => {
          if (live.detector !== null) return [];
          const pid = deps.ptys.pidFor(live.activeSessionId, 'agent');
          return pid === null
            ? []
            : [{ session: live.activeSessionId, runtime: live.runtimeId, pid }];
        }),
      changed: (id) => {
        this.emit('sessions-changed', { projectIds: [deps.sessions.get(id).project_id] });
      },
    });
    deps.ptys.on('data', (e: PtyDataEvent) => this.persistence.observe(() => this.onPtyData(e)));
    deps.ptys.on('exit', (e: PtyExitEvent) => this.persistence.observe(() => this.onPtyExit(e)));
    deps.ptys.on('input', (e: { stream: string; term: string }) => {
      if (e.term === 'agent') this.liveAgents.get(e.stream)?.lifecycleResource?.control?.input?.();
    });
    deps.ptys.on('env-delta', (e: PtyEnvDeltaEvent) =>
      this.persistence.observe(() => this.onEnvDelta(e)),
    );
    deps.ptys.on('cwd', (e: PtyCwdEvent) => this.persistence.observe(() => this.onCwd(e)));
    // Catch in-agent renames that emit no signal (see TITLE_REFRESH_MS). Unref'd
    // so it never keeps the process (or a test run) alive.
    this.titleTimer = setInterval(() => {
      if (Date.now() - this.lastPersistenceRetry >= 30_000) {
        this.lastPersistenceRetry = Date.now();
        const saved = this.persistence.retry();
        if (saved.length)
          this.emit('sessions-changed', {
            projectIds: [...new Set(saved.map((id) => deps.sessions.get(id).project_id))],
          });
      }
      for (const id of this.liveAgents.keys())
        this.persistence.observe(() => this.refreshAgentIdentity(id));
    }, this.deps.titleRefreshMs ?? TITLE_REFRESH_MS);
    this.titleTimer.unref?.();
  }

  /**
   * Daemon shutdown: PTYs are about to be killed, but their sessions must
   * KEEP their live status rows — the next boot's reconcile pass turns them
   * into `interrupted` (SPEC §4). Without this, the exit handlers would
   * record a graceful `exited` and the restart AT would lie.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
    clearInterval(this.titleTimer);
    this.terminalAgents.dispose();
  }

  get(id: string): Session {
    return this.withComputed(this.deps.sessions.get(id));
  }

  list(
    filter: { project_id?: string; profile_id?: string; status?: SessionStatus } = {},
  ): Session[] {
    return this.deps.sessions
      .list({ ...filter, status: undefined })
      .map((s) => this.withComputed(s))
      .filter((s) => filter.status === undefined || s.status === filter.status);
  }

  /**
   * Renames the puddle session only — the git branch is untouched (SPEC §6).
   * An empty title CLEARS the user override, so the display name reverts to the
   * agent's own name (`agent_title`), then the terminal-title name (`osc_title`),
   * then the session-id prefix.
   */
  rename(id: string, title: string): Session {
    this.deps.sessions.get(id);
    const trimmed = title.trim();
    this.deps.sessions.setTitle(id, trimmed === '' ? null : trimmed);
    const session = this.get(id);
    this.emit('renamed', {
      session: id,
      title: session.title,
      agent_title: session.agent_title ?? null,
      osc_title: session.osc_title ?? null,
    } satisfies RenameEvent);
    return session;
  }

  /**
   * Captures a minted conversation ref once it becomes visible, then refreshes
   * the independent human-readable agent name. Codex keeps its stable UUID in
   * `agent_session_ref` while `/rename` only changes the conversation's native
   * title; every placement reads that title through the store join.
   */
  private refreshAgentIdentity(sessionId: string): void {
    let session: Session;
    let account: Account;
    let adapter: AgentAdapter;
    try {
      session = this.deps.sessions.get(sessionId);
      if (session.kind !== 'agent' || session.account_id === null) return;
      account = this.deps.accounts.get(session.account_id);
      adapter = this.deps.adapters.get(session.agent_type ?? account.agent_type);
    } catch {
      return; // best-effort identity refresh; title refresh follows the same rule
    }
    void (
      session.agent_mode === 'headless'
        ? Promise.resolve(false)
        : this.sessionRefs.refreshAvailable(session, account, adapter)
    )
      .catch(() => false)
      .then(() => {
        this.bindRuntimeConversation(sessionId);
        this.persistence.observe(() => this.refreshAgentTitle(sessionId));
      });
  }

  /**
   * Re-reads the agent's own session name (adapter.sessionTitle) and, when it
   * changed, stores it on the native conversation and broadcasts — so an
   * attached client's joined `agent_title` tracks the agent live (a placement
   * user override still wins).
   * Best-effort: hooked off status changes and exit, and never throws upward.
   */
  private refreshAgentTitle(sessionId: string): void {
    let session: Session;
    try {
      session = this.deps.sessions.get(sessionId);
    } catch {
      return; // session gone
    }
    if (session.kind !== 'agent' || !session.agent_session_ref || session.account_id === null)
      return;
    let next: string | null;
    try {
      const account = this.deps.accounts.get(session.account_id);
      const adapter = this.deps.adapters.get(session.agent_type ?? account.agent_type);
      if (!adapter.sessionTitle) return;
      next = adapter.sessionTitle(session.agent_session_ref, account);
    } catch {
      return;
    }
    if ((next ?? null) === (session.agent_title ?? null)) return;
    this.persistence.observe(() => this.deps.sessions.setAgentTitle(sessionId, next));
    this.emit('renamed', {
      session: sessionId,
      title: session.title,
      agent_title: next,
      osc_title: session.osc_title ?? null,
    } satisfies RenameEvent);
  }

  async create(
    input: CreateSessionRequest,
    agentMode: NonNullable<Session['agent_mode']> = 'interactive',
  ): Promise<Session> {
    const project = this.deps.projects.get(input.project_id);
    const profile = this.deps.profiles.get(project.profile_id);
    const repo = this.deps.repos.get(project.repo_id);
    await this.deps.storage?.assertAdmission([...(this.deps.storagePaths ?? []), repo.path]);

    // A terminal session has no account/agent — it forks off into its own path
    // (a shell in the worktree, no onboarding, no conversation — SPEC §4).
    if ((input.kind ?? 'agent') === 'terminal') {
      if (agentMode === 'headless')
        throw ApiError.badRequest('agent_mode', 'Terminal placements cannot use headless mode');
      return this.createTerminal(input, project, profile, repo);
    }
    if (input.cwd !== undefined) {
      throw ApiError.badRequest('cwd_terminal_only', 'cwd applies to terminal sessions only');
    }
    if (input.account_id === undefined) {
      throw ApiError.badRequest('account_required', 'an agent session needs an account_id');
    }
    const account = this.deps.accounts.get(input.account_id);
    if (account.profile_id !== project.profile_id) {
      throw ApiError.badRequest(
        'foreign_account',
        'the account does not belong to this project’s profile',
      );
    }
    const adapter = this.deps.adapters.get(account.agent_type);
    if (agentMode === 'headless' && !adapter.prepareHeadlessLaunch)
      throw ApiError.badRequest(
        'agent_mode',
        `${adapter.displayName} does not support headless mode`,
      );
    assertBinaryAvailable(adapter); // before assertLoggedIn — see its doc comment
    await this.assertLoggedIn(account, adapter);

    // Permissions gate (SPEC §11): create REJECTS a denied request outright.
    const skip = this.evaluateSkip(project.profile_id, account, adapter, input.skip_permissions);
    if (input.skip_permissions === true && !skip) {
      throw ApiError.badRequest(
        'skip_permissions_denied',
        'skip_permissions requires the profile gate and the account opt-in',
      );
    }

    const separateBranch = input.separate_branch !== false;
    const separateWorktree = input.separate_worktree !== false; // agents: own dir by default
    const sessionId = randomUUID();
    const worktree = await this.resolveSessionWorktree({
      repo,
      profile,
      sessionId,
      input,
      separateBranch,
      separateWorktree,
    });
    const session = this.deps.sessions.create({
      id: sessionId,
      project_id: project.id,
      account_id: account.id,
      worktree_path: worktree.worktreePath,
      base_branch: worktree.baseBranch,
      branch: worktree.branch,
      separate_branch: separateBranch,
      branch_owned: worktree.created,
      kind: 'agent',
      agent_type: account.agent_type,
      agent_mode: agentMode,
      title: input.title ?? null,
      skip_permissions: skip,
    });

    // Every freshly created worktree onboards — and only those (SPEC §4).
    // Attaching to an existing shared worktree is a reuse, like a hand-off:
    // the environment already exists, so no onboarding — but other agents may
    // be working in that same directory, so the prompt carries a concurrency
    // heads-up rather than going in bare. The launch text is the profile's
    // template (Settings → Sessions), falling back to the built-in default.
    const settings = this.deps.profiles.getSettings(project.profile_id);
    const preamble = worktree.created
      ? buildOnboardingPreamble(
          settings.onboardingTemplate,
          repo.onboarding_notes,
          input.prompt ?? null,
        )
      : buildConcurrentWorktreeNote(settings.concurrentTemplate, input.prompt ?? null);
    const launchOpts = {
      worktreePath: worktree.worktreePath,
      sessionId,
      // A cleared template with no task prompt means no initial prompt at all.
      prompt: preamble === '' ? undefined : preamble,
      skipPermissions: skip,
    };
    const spawn = () =>
      this.spawnAgent(
        sessionId,
        worktree.worktreePath,
        account,
        adapter,
        adapter.launchArgs(launchOpts),
        'starting',
        launchOpts,
      );
    if (agentMode === 'headless') await spawn();
    else
      await this.sessionRefs.launchAndCapture(
        session,
        account,
        adapter,
        launchOpts,
        spawn,
        () => this.refreshAgentIdentity(sessionId),
        (error, phase) => {
          // Minted-id launches run after the HTTP response has returned, so no
          // request remains to carry an unexpected spawn/capture failure.
          const detail = (error as Error).message;
          console.warn(`agent ${phase} ${sessionId} failed: ${detail}`);
          if (phase === 'spawn') {
            this.emit('notice', {
              level: 'error',
              title: `${adapter.displayName} failed to start`,
              detail,
              session: sessionId,
              term: 'agent',
            } satisfies NoticeEvent);
          }
        },
      );
    this.bindRuntimeConversation(sessionId);
    // Adopt-after-first-write: the conversation file rarely exists this early,
    // so this is a best-effort first attempt; the waiting_input flip retries.
    this.scheduleAdopt(sessionId);
    this.deps.events.record(sessionId, 'created', {
      branch: worktree.branch,
      base_ref: worktree.baseRef,
      account_id: account.id,
      skip_permissions: skip,
      separate_branch: separateBranch,
      branch_owned: worktree.created,
      worktree_created: worktree.created,
    });
    // Only the worktree's creator watches its .puddle/ markers: in a shared
    // worktree, concurrent watchers would race to claim `session-title`.
    if (worktree.created) this.deps.onboarding.watch(sessionId, repo.id, worktree.worktreePath);
    this.deps.projects.touch(project.id);
    return this.get(session.id);
  }

  /**
   * A terminal session (SPEC §4): a plain shell PTY in a worktree, with no
   * account, no agent, and no onboarding. Unlike agent sessions it defaults to
   * the shared base-branch worktree (`separate_branch` off) — a scratch shell
   * usually wants the branch as-is, not a fresh one. There is no conversation
   * to adopt and no `.puddle/` markers to watch.
   */
  /**
   * Picks the worktree a new session lands in from the two independent axes
   * (SPEC §4): `separate_branch` (a fresh branch in its own worktree, vs. the
   * base branch) and `separate_worktree` (its own directory, vs. sharing one).
   * A separate branch always gets its own directory; only a base-branch session
   * may share. `join_session` shares a specific existing session's directory;
   * otherwise sharing uses the base branch's canonical shared worktree. Shared
   * by both the agent and terminal create paths.
   */
  private async resolveSessionWorktree(opts: {
    repo: ReturnType<RepoStore['get']>;
    profile: ReturnType<ProfileStore['get']>;
    sessionId: string;
    input: CreateSessionRequest;
    separateBranch: boolean;
    /** Effective directory axis (its own default already applied per kind). */
    separateWorktree: boolean;
  }): Promise<CreateWorktreeResult> {
    const { repo, profile, sessionId, input, separateBranch, separateWorktree } = opts;

    if (separateBranch) {
      // A separate branch always gets its own directory; an explicit request to
      // share one alongside it is a contradiction.
      if (input.separate_worktree === false) {
        throw ApiError.badRequest(
          'shared_worktree_needs_shared_branch',
          'sharing a working directory requires working on the base branch — disable separate branch first',
        );
      }
      if (input.join_worktree !== undefined) {
        throw ApiError.badRequest(
          'join_needs_shared_branch',
          'joining an existing directory requires working on the base branch — disable separate branch first',
        );
      }
      return this.deps.worktrees.create({
        repo,
        sessionId,
        baseBranch: input.base_branch,
        requestedBranch: input.branch,
        title: input.title ?? null,
        prompt: input.prompt ?? null,
        branchPrefix: profile.branch_prefix,
      });
    }

    // Base branch (no separate branch): a `branch` name makes no sense here.
    if (input.branch !== undefined) {
      throw ApiError.badRequest(
        'branch_with_shared',
        'a session without a separate branch works directly on the base branch; omit branch',
      );
    }

    // Land in a specific existing worktree (the clone or any other on the branch).
    if (input.join_worktree !== undefined) {
      return this.deps.worktrees.joinWorktree({ repo, worktreePath: input.join_worktree });
    }

    // Own new directory on the base branch, or the branch's default shared
    // directory (the clone if on that branch, else the canonical shared
    // worktree) when the caller shares one.
    return separateWorktree
      ? this.deps.worktrees.createOnBase({ repo, sessionId, baseBranch: input.base_branch })
      : this.deps.worktrees.attachShared({ repo, baseBranch: input.base_branch });
  }

  /** Internal explicit execution; the command is never persisted or replayed on resume. */
  async createCommandTerminal(
    input: CreateSessionRequest,
    command: TerminalCommand,
  ): Promise<Session> {
    const project = this.deps.projects.get(input.project_id);
    return this.createTerminal(
      { ...input, kind: 'terminal' },
      project,
      this.deps.profiles.get(project.profile_id),
      this.deps.repos.get(project.repo_id),
      command,
    );
  }

  private async createTerminal(
    input: CreateSessionRequest,
    project: ReturnType<ProjectStore['get']>,
    profile: ReturnType<ProfileStore['get']>,
    repo: ReturnType<RepoStore['get']>,
    command?: TerminalCommand,
  ): Promise<Session> {
    await this.deps.storage?.assertAdmission([...(this.deps.storagePaths ?? []), repo.path]);
    const separateBranch = input.separate_branch === true; // default off for terminals
    const separateWorktree = input.separate_worktree === true; // terminals: share by default
    const sessionId = randomUUID();
    const worktree = await this.resolveSessionWorktree({
      repo,
      profile,
      sessionId,
      input,
      separateBranch,
      separateWorktree,
    });
    const session = this.deps.sessions.create({
      id: sessionId,
      project_id: project.id,
      account_id: null,
      worktree_path: worktree.worktreePath,
      base_branch: worktree.baseBranch,
      branch: worktree.branch,
      separate_branch: separateBranch,
      kind: 'terminal',
      agent_type: null,
      title: input.title ?? null,
      skip_permissions: false,
      // Validated before the row exists, so a bad cwd leaves no half-made session.
      cwd: this.validateCwd(worktree.worktreePath, input.cwd),
    });
    this.spawnTerminal(sessionId, this.startDirOf(session), command);
    this.deps.events.record(sessionId, 'created', {
      branch: worktree.branch,
      base_ref: worktree.baseRef,
      kind: 'terminal',
      separate_branch: separateBranch,
      worktree_created: worktree.created,
    });
    this.deps.projects.touch(project.id);
    return this.get(session.id);
  }

  /**
   * Launches (or relaunches) a terminal session's shell on the `agent` PTY term
   * so the existing terminal view attaches to it unchanged. No status detector:
   * a shell only flips `starting → running` on first output and `→ exited` when
   * it dies (SPEC §4).
   */
  /**
   * Validates a requested terminal start directory and returns it in the
   * WORKTREE-RELATIVE form the column stores, or null for the worktree root.
   *
   * Relative so the stored value cannot drift from `worktree_path`, and run
   * through the same containment guard the file routes use, so a `..` can never
   * name a directory outside the worktree.
   */
  private validateCwd(worktreeRoot: string, cwd: string | undefined): string | null {
    if (cwd === undefined || cwd === '') return null;
    const absolute = containedPath(worktreeRoot, cwd);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw ApiError.badRequest('cwd_not_a_directory', `cwd '${cwd}' is not a directory`);
    }
    const rel = relative(worktreeRoot, absolute);
    return rel === '' ? null : rel;
  }

  /**
   * Where this session's shells start: its recorded `cwd` under the worktree,
   * else the worktree root. Falls back to the root if the directory has since
   * been deleted — a stale `cwd` must not make the session unspawnable.
   */
  private startDirOf(session: Session): string {
    const cwd = session.cwd ?? null;
    if (cwd === null || cwd === '') return session.worktree_path;
    const absolute = join(session.worktree_path, cwd);
    return existsSync(absolute) && statSync(absolute).isDirectory()
      ? absolute
      : session.worktree_path;
  }

  private spawnTerminal(sessionId: string, worktreePath: string, command?: TerminalCommand): void {
    const { shell, args, env } = this.shellSpawnParts(sessionId);
    try {
      this.deps.ptys.spawn(
        sessionId,
        'agent',
        command ? '/bin/sh' : shell,
        command ? terminalCommandArgs(command, shell, args) : args,
        { cwd: command?.cwd ?? worktreePath, env: { ...env, ...command?.env } },
      );
    } catch (e) {
      this.transition(sessionId, 'exited');
      this.deps.events.record(sessionId, 'spawn_failed', { message: (e as Error).message });
      throw new ApiError(500, 'spawn_failed', `could not start ${shell}: ${(e as Error).message}`);
    }
    const live: LiveAgent = {
      runtimeId: randomUUID(),
      activeSessionId: sessionId,
      conversationId: null,
      lifecycleResource: null,
      detector: null,
      startedAt: Date.now(),
      status: 'starting',
      lastTouch: 0,
      lastTitleCheck: 0,
      lastOscTitle: null,
      signalNonce: null,
      signalled: false,
    };
    this.liveAgents.set(sessionId, live);
    this.runtimes.set(live.runtimeId, live);
  }

  async resume(id: string): Promise<Session> {
    return this.lifecycleMutex.run('native-conversation-switch', () => this.resumeCore(id));
  }

  private async resumeCore(id: string): Promise<Session> {
    const session = this.deps.sessions.get(id);
    await this.deps.storage?.assertAdmission([
      ...(this.deps.storagePaths ?? []),
      session.worktree_path,
    ]);
    if (session.conversation_missing) {
      throw ApiError.conflict(
        'conversation_missing',
        'the native conversation no longer exists; this placement cannot resume',
      );
    }
    if (session.conversation_id !== null && session.conversation_id !== undefined) {
      const owner = this.conversationRuntimes.get(session.conversation_id);
      if (owner && owner.activeSessionId !== id) {
        const existing = this.deps.sessions.get(owner.activeSessionId);
        throw ApiError.conflict(
          'conversation_live',
          'this native conversation is already running in another placement',
          { existing_session_id: existing.id, existing_project_id: existing.project_id },
        );
      }
    }
    if (session.status !== 'exited' && session.status !== 'interrupted') {
      throw ApiError.conflict(
        'not_resumable',
        `session is ${session.status}; only exited or interrupted sessions resume`,
      );
    }
    if (!existsSync(session.worktree_path)) {
      throw ApiError.conflict(
        'worktree_missing',
        'worktree is gone; the session can only be archived',
      );
    }
    // A terminal session has no conversation to resume — a shell process cannot
    // be reattached across a restart — so "resume" just relaunches a fresh
    // shell, in the SAME directory it was opened in (`cwd`, SPEC §4).
    if (session.kind === 'terminal') {
      const wasInterrupted = session.status === 'interrupted';
      this.spawnTerminal(session.id, this.startDirOf(session));
      this.transition(session.id, 'running');
      this.deps.events.record(id, 'resumed', { was_interrupted: wasInterrupted });
      return this.get(id);
    }
    if (session.account_id === null || session.agent_type === null) {
      throw ApiError.conflict('not_resumable', 'session has no agent to resume');
    }
    const account = this.deps.accounts.get(session.account_id);
    const project = this.deps.projects.get(session.project_id);
    const adapter = this.deps.adapters.get(session.agent_type);
    if (!adapter.capabilities.resume) {
      throw ApiError.badRequest(
        'resume_unsupported',
        `${adapter.displayName} cannot resume conversations`,
      );
    }
    assertBinaryAvailable(adapter); // before assertLoggedIn — see its doc comment
    await this.assertLoggedIn(account, adapter);
    const ref =
      session.agent_mode === 'headless' && !session.agent_session_ref
        ? undefined
        : await this.sessionRefs.resolveForResume(session, account, adapter);

    const wasInterrupted = session.status === 'interrupted';
    const { skip } = await this.resumeSpawn(session, account, adapter, project.profile_id, ref, {
      interruptedNote: wasInterrupted,
    });
    this.deps.events.record(id, 'resumed', {
      was_interrupted: wasInterrupted,
      skip_permissions: skip,
    });
    this.deps.onboarding.watch(id, project.repo_id, session.worktree_path);
    return this.get(id);
  }

  /**
   * Shared resume spawn path for `resume` and `migrate` (SPEC §11.4). The
   * permissions gate is RE-EVALUATED for THIS account at THIS moment — a
   * session that ran without prompts loses the flag if the gate has since
   * closed or the target account never opted in; the resume continues with
   * prompts on and says so in the terminal (a silent downgrade, never a hard
   * failure). Spawns the agent under the account's env in the session's
   * worktree, transitions to `running`, and returns the effective flags. The
   * caller records the lifecycle event (`resumed` / `migrated`).
   */
  private async resumeSpawn(
    session: Session,
    account: Account,
    adapter: AgentAdapter,
    profileId: string,
    ref: string | undefined,
    opts: { interruptedNote: boolean },
  ): Promise<{ skip: boolean; downgraded: boolean }> {
    const skip = this.evaluateSkip(profileId, account, adapter, session.skip_permissions);
    const downgraded = session.skip_permissions && !skip;
    if (downgraded) this.deps.sessions.setSkipPermissions(session.id, false);
    // The interruption note is the profile's `restartTemplate` (Settings →
    // Sessions), falling back to the built-in default; a cleared template sends
    // no note at all.
    let restartNote: string | undefined;
    if (opts.interruptedNote) {
      const note = buildInterruptedResumeNote(
        this.deps.profiles.getSettings(profileId).restartTemplate,
      );
      restartNote = note.trim() === '' ? undefined : note;
    }
    const launchOpts = {
      worktreePath: session.worktree_path,
      sessionId: session.id,
      prompt: restartNote,
      skipPermissions: skip,
    };
    const args = ref ? adapter.resumeArgs(ref, launchOpts) : adapter.launchArgs(launchOpts);
    await this.spawnAgent(
      session.id,
      session.worktree_path,
      account,
      adapter,
      args,
      'running',
      launchOpts,
      ref,
    );
    this.bindRuntimeConversation(session.id);
    this.transition(session.id, 'running');
    if (downgraded) {
      this.deps.ptys.note(
        session.id,
        'agent',
        'skip-permissions no longer permitted; continuing with prompts on.',
      );
    }
    return { skip, downgraded };
  }

  /**
   * Tier-1 migration (SPEC §5): move a session to another account of the same
   * (profile, agent) and resume it under that account's credentials. The
   * conversation does NOT move — it lives in the profile's shared store,
   * reachable from every account through its symlinks — so migration is
   * "stop the process, repoint `account_id`, resume under B's env".
   */
  async migrate(id: string, targetAccountId: number): Promise<Session> {
    const session = this.deps.sessions.get(id);
    if (session.kind === 'terminal' || session.account_id === null || session.agent_type === null) {
      throw ApiError.badRequest('not_migratable', 'a terminal session has no account to migrate');
    }
    const project = this.deps.projects.get(session.project_id);
    const target = this.deps.accounts.get(targetAccountId); // 404 if unknown
    // Validations, in order (SPEC §5).
    if (target.profile_id !== project.profile_id) {
      throw ApiError.badRequest(
        'cross_profile_account',
        'the target account belongs to a different profile',
      );
    }
    if (target.agent_type !== session.agent_type) {
      throw ApiError.badRequest(
        'agent_mismatch',
        `the target account runs ${target.agent_type}, not ${session.agent_type}`,
      );
    }
    if (target.id === session.account_id) {
      throw ApiError.badRequest('same_account', 'the session already runs on this account');
    }
    // An archived session has no live worktree/process to carry over.
    if (session.status === 'archived') {
      throw ApiError.conflict('session_archived', 'an archived session cannot migrate');
    }
    // Same guard resume has: a vanished worktree is a 409, not a spawn 500.
    if (!existsSync(session.worktree_path)) {
      throw ApiError.conflict(
        'worktree_missing',
        'worktree is gone; the session can only be archived',
      );
    }
    const adapter = this.deps.adapters.get(session.agent_type);
    // A live session is stopped first — usually it has already exited (credit
    // exhaustion). kill() waits for the PTY to die before returning.
    if (LIVE_STATUSES.includes(session.status)) await this.kill(id);
    // The target must be logged in — the same probe create/resume use.
    assertBinaryAvailable(adapter); // before assertLoggedIn — see its doc comment
    await this.assertLoggedIn(target, adapter);

    const ref = session.agent_session_ref;
    if (!ref) throw ApiError.conflict('no_session_ref', 'no agent session ref recorded');

    // A session that exhausted credit on its very FIRST turn may never have hit
    // waiting_input, so its conversation was never adopted into the shared store
    // — `hasConversation(target)` below would then be false and migration would
    // wrongly 409, defeating the primary use case. Force a best-effort adopt now
    // (the source account is still `account_id`, so it owns the files); an
    // adoption failure simply falls through to the availability paths below.
    if (this.deps.share) {
      try {
        await this.deps.share.adoptIfNeeded(session);
      } catch {
        /* best-effort — falls through to the (a)/(b)/(c) availability paths */
      }
    }

    // Conversation availability on the target, in fall-through order (SPEC §5):
    // (a) readable through the shared store's symlink — no files move;
    // (b) an agent without a shareable store copies its state across (rolled
    //     back on a later failure per the adapter contract);
    // (c) neither — the conversation cannot follow the account.
    let rollback: (() => Promise<void>) | null = null;
    if (adapter.conversationShare && (await adapter.hasConversation?.(ref, target))) {
      // (a) — nothing to do; the target already reads the conversation.
    } else if (adapter.migrateSession) {
      const from = this.deps.accounts.get(session.account_id);
      await adapter.migrateSession(ref, from, target, session.worktree_path);
      rollback = async () => {
        try {
          await adapter.migrateSession!(ref, target, from, session.worktree_path);
        } catch {
          /* best-effort — the copied files are the caller's to reconcile */
        }
      };
    } else {
      throw ApiError.conflict(
        'migration_unsupported',
        `${adapter.displayName} cannot migrate this conversation to another account`,
      );
    }

    const fromAccountId = session.account_id;
    this.deps.sessions.setAccountId(id, target.id);
    try {
      await this.resumeSpawn(session, target, adapter, project.profile_id, ref, {
        interruptedNote: false,
      });
    } catch (e) {
      // Path (b) rolls the copied files back and reverts the account (409).
      // Path (a) leaves `account_id` on the target — the conversation is
      // shared, so a plain retry resume recovers — and surfaces the error.
      if (rollback) {
        await rollback();
        this.deps.sessions.setAccountId(id, fromAccountId);
      }
      throw e;
    }
    this.deps.events.record(id, 'migrated', {
      from_account: fromAccountId,
      to_account: target.id,
    });
    // Resume the marker-file sync the way resume() does, so a shared-worktree
    // session keeps title/onboarding markers flowing after migration.
    this.deps.onboarding.watch(id, project.repo_id, session.worktree_path);
    return this.get(id);
  }

  /**
   * Tier-2 cross-agent hand-off (SPEC §5): continue this session's work on a
   * DIFFERENT agent. Nothing moves — no shared conversation format exists — so
   * a new session is created in the same worktree and branch, seeded with a
   * briefing summarising the conversation and the branch state. The source
   * session is deliberately left alone: it keeps its status and its history,
   * and the two are linked by events.
   */
  async handoff(id: string, targetAccountId: number): Promise<Session> {
    const session = this.deps.sessions.get(id);
    if (session.kind === 'terminal' || session.account_id === null || session.agent_type === null) {
      throw ApiError.badRequest('not_migratable', 'a terminal session has no agent to hand off');
    }
    const project = this.deps.projects.get(session.project_id);
    const target = this.deps.accounts.get(targetAccountId); // 404 if unknown
    // Validations mirror migrate()'s, in the same order (SPEC §5).
    if (target.profile_id !== project.profile_id) {
      throw ApiError.badRequest(
        'cross_profile_account',
        'the target account belongs to a different profile',
      );
    }
    if (target.agent_type === session.agent_type) {
      throw ApiError.badRequest(
        'same_agent',
        `the target account also runs ${session.agent_type}; use migrate to move between accounts of one agent`,
      );
    }
    if (session.status === 'archived') {
      throw ApiError.conflict('session_archived', 'an archived session cannot hand off');
    }
    if (!existsSync(session.worktree_path)) {
      throw ApiError.conflict(
        'worktree_missing',
        'worktree is gone; the session can only be archived',
      );
    }
    const targetAdapter = this.deps.adapters.get(target.agent_type);
    assertBinaryAvailable(targetAdapter); // before assertLoggedIn — see its doc comment
    await this.assertLoggedIn(target, targetAdapter);

    const prompt = await buildHandoffPrompt({
      adapter: this.deps.adapters.get(session.agent_type),
      account: this.deps.accounts.get(session.account_id),
      session,
      logs: this.deps.logs,
    });
    // `join_worktree` lands the new session in the source's directory, on
    // whatever branch is checked out there — no second `git worktree add`, and
    // no onboarding, since the worktree is a reuse rather than a fresh one.
    const created = await this.create({
      project_id: session.project_id,
      account_id: target.id,
      separate_branch: false,
      separate_worktree: false,
      join_worktree: session.worktree_path,
      prompt,
      skip_permissions: session.skip_permissions,
    });
    this.deps.events.record(id, 'handed_off_to', {
      to_session: created.id,
      to_account: target.id,
      to_agent: target.agent_type,
    });
    this.deps.events.record(created.id, 'handed_off_from', {
      from_session: id,
      from_account: session.account_id,
      from_agent: session.agent_type,
    });
    return created;
  }

  /** SIGTERM the session's PTYs and wait for the agent to exit. */
  async kill(id: string): Promise<Session> {
    const session = this.deps.sessions.get(id);
    this.expectExit(id); // asked for: its non-zero exit raises no notice
    this.deps.ptys.killAll(id);
    const deadline = Date.now() + 4000;
    let escalated = false;
    while (this.deps.ptys.has(id, 'agent')) {
      if (Date.now() > deadline + 2000)
        throw new ApiError(500, 'kill_failed', 'agent PTY refused to die');
      if (!escalated && Date.now() > deadline) {
        this.deps.ptys.kill(id, 'agent', 'SIGKILL');
        escalated = true;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    if (LIVE_STATUSES.includes(session.status)) {
      // The exit handler normally does this; cover the no-PTY edge.
      if (this.deps.sessions.get(id).status !== 'exited') this.transition(id, 'exited');
    }
    this.deps.events.record(id, 'killed');
    return this.get(id);
  }

  /**
   * Archive a session (SPEC §4): a reversible hide, NOT a teardown. A live
   * session is killed first; the worktree, its branch, and the agent's
   * conversation all stay exactly where they are, so the session can be
   * unarchived later and — if its worktree is still on disk — resumed with
   * its history intact. Reclaiming a worktree's disk is a separate, explicit
   * action in the Worktrees manager; deleting a branch is done there too
   * (git refuses while the branch is checked out in the kept worktree).
   */
  async archive(id: string): Promise<Session> {
    const session = this.deps.sessions.get(id);
    if (session.status === 'archived') return session; // an idempotent hide
    // A live session is killed as part of archiving — one gesture from the
    // UI, no kill-then-archive dance. Still nothing is destroyed: the
    // conversation stays exactly as resumable after an unarchive.
    if (LIVE_STATUSES.includes(session.status)) await this.kill(id);
    this.deps.onboarding.unwatch(id);
    this.adopted.delete(id);
    this.transition(id, 'archived');
    this.deps.events.record(id, 'archived', {});
    return this.get(id);
  }

  /**
   * Reverse an archive (SPEC §4): bring the session back to a resumable state.
   * We never recreate a worktree — if it was pruned, or its branch was moved or
   * deleted, the session returns visible for its terminal/conversation history
   * only, with resume disabled through the read-time `worktree_missing` flag.
   */
  async unarchive(id: string): Promise<Session> {
    const session = this.deps.sessions.get(id);
    if (session.status !== 'archived') {
      throw ApiError.conflict('not_archived', 'only an archived session can be unarchived');
    }
    const worktreePresent = existsSync(session.worktree_path);
    this.transition(id, 'exited');
    this.deps.events.record(id, 'unarchived', { worktree_present: worktreePresent });
    if (worktreePresent) {
      const project = this.deps.projects.get(session.project_id);
      this.deps.onboarding.watch(id, project.repo_id, session.worktree_path);
    }
    return this.get(id);
  }

  /** Archives all sessions of a project; refuses live ones unless forced (SPEC §4). */
  async archiveProject(projectId: string, force = false): Promise<void> {
    this.deps.projects.get(projectId); // 404 guard
    const sessions = this.deps.sessions.list({ project_id: projectId });
    const live = sessions.filter((s) => LIVE_STATUSES.includes(s.status));
    if (live.length > 0 && !force) {
      throw ApiError.conflict(
        'project_live',
        `${live.length} session(s) are running or waiting; archive with force to kill them`,
      );
    }
    for (const s of live) await this.kill(s.id);
    for (const s of sessions) {
      if (s.status !== 'archived') await this.archive(s.id);
    }
  }

  /** Spawn a shell PTY cd'd into the worktree; returns the new term id. */
  spawnShell(sessionId: string): string {
    const session = this.deps.sessions.get(sessionId);
    if (session.status === 'archived') {
      throw ApiError.conflict('session_archived', 'archived sessions have no worktree');
    }
    if (!existsSync(session.worktree_path)) {
      throw ApiError.conflict('worktree_missing', 'worktree is gone');
    }
    const used = new Set([
      ...this.deps.logs.listTerms(sessionId),
      ...this.deps.ptys.liveTerms(sessionId),
    ]);
    let n = 1;
    while (used.has(`shell-${n}`)) n++;
    const term = `shell-${n}`;
    const { shell, args, env } = this.shellSpawnParts(sessionId);
    // A second shell opens where the session lives, matching its first one.
    this.deps.ptys.spawn(sessionId, term, shell, args, { cwd: this.startDirOf(session), env });
    return term;
  }

  /**
   * Stored logged-in flags go stale (keychain-bound credentials die with a
   * path change) — ask the agent before anything spawns, and keep the flag
   * truthful. A logged-out account would otherwise show its login screen
   * INSIDE the session and discard the preset session id.
   *
   * ALWAYS call `assertBinaryAvailable` first. Adapters implement `checkLoggedIn`
   * by asking their own CLI, so an uninstalled agent reports "logged out" — and
   * the write below would then clear a perfectly good `logged_in` flag and send
   * the user to a login flow that cannot work. This assumes the binary exists.
   */
  private async assertLoggedIn(account: Account, adapter: AgentAdapter): Promise<void> {
    if (!adapter.checkLoggedIn) return;
    const loggedIn = await adapter.checkLoggedIn(account);
    if (loggedIn !== account.logged_in) this.deps.accounts.setLoggedIn(account.id, loggedIn);
    if (!loggedIn) {
      throw ApiError.conflict(
        'account_logged_out',
        `account '${account.label}' is not logged in — log in via Settings → Accounts first`,
      );
    }
  }

  /** requested ∧ profile gate ∧ account opt-in ∧ adapter capability (SPEC §11). */
  private evaluateSkip(
    profileId: string,
    account: Account,
    adapter: AgentAdapter,
    requested: boolean | undefined,
  ): boolean {
    if (requested !== true) return false;
    if (!adapter.capabilities.skipPermissions) return false;
    const settings = this.deps.profiles.getSettings(profileId);
    return settings.allowSkipPermissions === true && account.skip_permissions_default;
  }

  /** The profile gate for captured env (SPEC §4): reporting, consumption, and re-injection. */
  private captureEnvEnabled(projectId: string): boolean {
    const project = this.deps.projects.get(projectId);
    return this.deps.profiles.getSettings(project.profile_id).captureSessionEnv;
  }

  /**
   * Consume a captured-env report from a session PTY's OSC 7733 side-channel.
   * Non-session streams (home, login-*) report nothing consumable; denylist and
   * caps are re-checked here even though the hook filters — the emitter is an
   * arbitrary process in the worktree, not just our hook.
   */
  private onEnvDelta(e: PtyEnvDeltaEvent): void {
    if (this.shuttingDown) return;
    let session: Session;
    try {
      session = this.deps.sessions.get(e.stream);
    } catch {
      return;
    }
    if (!this.captureEnvEnabled(session.project_id)) return;
    const { delta } = e;
    if (isDeniedEnvName(delta.name)) return;
    if (delta.op === 'unset') {
      this.deps.sessions.mergeEnv(session.id, {}, [delta.name]);
      return;
    }
    const value = delta.value ?? '';
    if (Buffer.byteLength(value) > MAX_ENV_VALUE_BYTES) {
      this.noteEnvDropOnce(session.id, e.term, delta.name, 'its value exceeds 32 KiB');
      return;
    }
    const current = this.deps.sessions.getEnv(session.id);
    if (!(delta.name in current) && Object.keys(current).length >= MAX_ENV_VARS) {
      this.noteEnvDropOnce(
        session.id,
        e.term,
        delta.name,
        `the session already holds ${MAX_ENV_VARS} captured vars`,
      );
      return;
    }
    this.deps.sessions.mergeEnv(session.id, { [delta.name]: value }, []);
  }

  /**
   * Persist a terminal shell's last prompt directory for its next spawn. The
   * public cwd contract is deliberately worktree-relative, so an outside cwd
   * resets the restart location to the worktree root instead of storing an
   * arbitrary absolute path. Agent sessions ignore shell-tab reports.
   */
  private onCwd(e: PtyCwdEvent): void {
    if (this.shuttingDown) return;
    let session: Session;
    try {
      session = this.deps.sessions.get(e.stream);
    } catch {
      return;
    }
    if (session.kind !== 'terminal') return;

    const absolute = resolve(e.cwd);
    try {
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return;
    } catch {
      // The directory may disappear between exists/stat; ignore a stale prompt.
      return;
    }
    const rel = relative(resolve(session.worktree_path), absolute);
    const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    const cwd = outside || rel === '' ? null : rel;
    if ((session.cwd ?? null) !== cwd) this.deps.sessions.setCwd(session.id, cwd);
  }

  private noteEnvDropOnce(sessionId: string, term: string, name: string, reason: string): void {
    const key = `${sessionId}:${name}`;
    if (this.envDropNoted.has(key)) return;
    this.envDropNoted.add(key);
    this.deps.ptys.note(sessionId, term, `captured env: ${name} not persisted — ${reason}`);
  }

  /**
   * Captured vars to merge into a session PTY's spawn env, denylist-refiltered
   * (defence against rows written by an older build). Empty when the profile
   * gate is off — the feature goes fully dormant, but the stored map is kept.
   */
  private capturedSpawnEnv(session: Session): Record<string, string> {
    if (!this.captureEnvEnabled(session.project_id)) return {};
    return Object.fromEntries(
      Object.entries(this.deps.sessions.getEnv(session.id)).filter(([k]) => !isDeniedEnvName(k)),
    );
  }

  /** Captured vars for the authenticated cockpit's env strip (SPEC §4). */
  capturedEnv(id: string): SessionEnvResponse {
    const env = this.deps.sessions.getEnv(id); // 404s for an unknown session
    const vars = Object.entries(env)
      .map(([name, value]) => ({ name, value, bytes: Buffer.byteLength(value) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { vars };
  }

  /** DELETE /api/sessions/:id/env: stop injecting; returns how many vars were dropped. */
  clearCapturedEnv(id: string): ClearSessionEnvResponse {
    return { cleared: this.deps.sessions.clearEnv(id) };
  }

  /** Shell command, hook args, and env for a session terminal spawn (SPEC §4). */
  private shellSpawnParts(sessionId: string): {
    shell: string;
    args: string[];
    env: Record<string, string>;
  } {
    const shell = process.env.SHELL ?? 'bash';
    const session = this.deps.sessions.get(sessionId);
    const captureEnv = this.captureEnvEnabled(session.project_id);
    const captured = this.capturedSpawnEnv(session);
    const historyFile = this.deps.logs.historyFile(sessionId);
    const hook = this.deps.shellHooks?.spawnConfig(shell, { captureEnv, historyFile });
    // Hook control vars win over anything captured (ZDOTDIR is denylisted anyway).
    return {
      shell,
      args: hook?.args ?? [],
      env: { ...captured, HISTFILE: historyFile, ...(hook?.env ?? {}) },
    };
  }

  private async spawnAgent(
    sessionId: string,
    worktreePath: string,
    account: Account,
    adapter: AgentAdapter,
    args: string[],
    initial: LiveAgent['status'],
    launchOpts?: LaunchOpts,
    resumeRef?: string,
  ): Promise<void> {
    await this.deps.storage?.assertAdmission([
      ...(this.deps.storagePaths ?? []),
      worktreePath,
      account.config_dir,
    ]);
    // The status-signal side-channel (SPEC §4): a per-spawn nonce plus the
    // daemon's own /agent-signal URL, injected so agent hook processes (which
    // inherit this env) can report running ⇄ waiting_input authoritatively.
    const signalNonce = this.signalPort !== null ? randomUUID() : null;
    // A fresh agent is never an expected exit — clear any flag a previous
    // kill left behind so this run's crash is reported.
    this.expectedExits.delete(sessionId);
    let lifecycleResource: LifecycleLaunchResource | null = null;
    let spawnArgs = args;
    let nativeSync: NonNullable<Session['native_sync']> = 'fallback';
    const headless = this.deps.sessions.get(sessionId).agent_mode === 'headless';
    if (headless && (signalNonce === null || !adapter.prepareHeadlessLaunch)) {
      this.transition(sessionId, 'exited');
      throw ApiError.conflict(
        'headless_mode_unavailable',
        'Headless execution requires an adapter control channel',
      );
    }
    if (signalNonce !== null && this.signalPort !== null) {
      const prepare = headless ? adapter.prepareHeadlessLaunch : adapter.prepareLifecycleLaunch;
      if (prepare) {
        try {
          lifecycleResource = await prepare({
            account,
            opts: launchOpts ?? {
              worktreePath,
              sessionId,
              skipPermissions: this.deps.sessions.get(sessionId).skip_permissions,
            },
            args,
            signalUrl: `http://127.0.0.1:${this.signalPort}/agent-signal`,
            signalNonce,
            resumeRef,
            env: this.capturedSpawnEnv(this.deps.sessions.get(sessionId)),
            writeInput: (data) => {
              const live = this.signalNonces.get(signalNonce);
              if (!live) throw new Error('Agent terminal is no longer live');
              this.deps.ptys.write(live.activeSessionId, 'agent', data, 'script');
            },
            reportStatus: (state) => {
              this.signalAgentStatus(signalNonce, state);
            },
            bindConversation: async (ref) => {
              const accepted = await this.signalAgentLifecycle({
                nonce: signalNonce,
                event: 'session_start',
                agent_session_ref: ref,
                cwd: worktreePath,
                source: resumeRef ? 'resume' : 'startup',
              });
              if (!accepted)
                throw new Error('Agent runtime ended before its conversation was bound');
            },
          });
          spawnArgs = lifecycleResource.args;
          nativeSync = 'full';
        } catch (error) {
          if (headless) {
            this.transition(sessionId, 'exited');
            this.deps.events.record(sessionId, 'spawn_failed', { message: String(error) });
            throw ApiError.conflict('headless_mode_unavailable', String(error));
          }
          console.warn(
            `${adapter.displayName} lifecycle bridge unavailable: ${(error as Error).message}`,
          );
        }
      } else if (adapter.lifecycleSignals) {
        try {
          nativeSync =
            (await adapter.checkLifecycleSupport?.(account)) === false ? 'fallback' : 'full';
        } catch (error) {
          console.warn(
            `${adapter.displayName} lifecycle capability check failed: ${(error as Error).message}`,
          );
        }
      }
    }
    try {
      this.deps.ptys.spawn(
        sessionId,
        'agent',
        lifecycleResource?.binary ?? adapter.binary,
        spawnArgs,
        {
          cwd: worktreePath,
          // Adapter env is sacrosanct (e.g. CLAUDE_CONFIG_DIR) — it wins over
          // captured vars; process.env is merged underneath by PtyManager.
          env: {
            ...this.capturedSpawnEnv(this.deps.sessions.get(sessionId)),
            ...adapter.env(account),
            ...(signalNonce !== null
              ? {
                  PUDDLE_AGENT_SIGNAL_URL: `http://127.0.0.1:${this.signalPort}/agent-signal`,
                  PUDDLE_AGENT_SIGNAL_NONCE: signalNonce,
                }
              : {}),
          },
        },
      );
    } catch (e) {
      await lifecycleResource?.dispose();
      this.transition(sessionId, 'exited');
      this.deps.events.record(sessionId, 'spawn_failed', { message: (e as Error).message });
      throw new ApiError(
        500,
        'spawn_failed',
        `could not start ${adapter.binary}: ${(e as Error).message}`,
      );
    }
    // Detector callbacks follow the stable runtime's current placement. A
    // closure over the spawn-time session id would silently stop status
    // updates after a native switch for regex-driven agents.
    let live: LiveAgent | null = null;
    const detector = new StatusDetector(
      adapter.statusPatterns,
      {
        onStatus: (s) =>
          this.persistence.observe(() => this.onDetected(live?.activeSessionId ?? sessionId, s)),
        onLimitReached: () =>
          this.persistence.observe(() =>
            this.deps.events.record(live?.activeSessionId ?? sessionId, 'limit_reached'),
          ),
      },
      this.deps.statusQuietMs ?? 2000,
    );
    const current = this.deps.sessions.get(sessionId);
    live = {
      runtimeId: randomUUID(),
      activeSessionId: sessionId,
      conversationId: current.conversation_id ?? null,
      lifecycleResource,
      detector,
      startedAt: Date.now(),
      status: initial,
      lastTouch: 0,
      lastTitleCheck: 0,
      lastOscTitle: null,
      signalNonce,
      signalled: false,
    };
    this.liveAgents.set(sessionId, live);
    this.runtimes.set(live.runtimeId, live);
    if (live.conversationId !== null) this.conversationRuntimes.set(live.conversationId, live);
    if (signalNonce !== null) this.signalNonces.set(signalNonce, live);
    if (lifecycleResource?.sidecarPids?.length || lifecycleResource?.hiddenPorts?.length) {
      this.deps.ptys.registerSidecars(
        sessionId,
        lifecycleResource.sidecarPids ?? [],
        lifecycleResource.hiddenPorts ?? [],
      );
    }
    this.deps.sessions.setNativeSync(sessionId, nativeSync);
    if (nativeSync === 'fallback' && signalNonce !== null) {
      this.emit('notice', {
        level: 'warning',
        title: 'Conversation switching is not synchronised',
        detail: `${adapter.displayName} will keep running, but in-agent conversation switches will stay in this terminal tab.`,
        session: sessionId,
      } satisfies NoticeEvent);
    }
  }

  private onPtyData(e: PtyDataEvent): void {
    if (this.shuttingDown) return;
    const live = this.liveAgents.get(e.stream);
    if (!live) return;
    const now = Date.now();
    if (now - live.lastTouch > 1000) {
      live.lastTouch = now;
      this.persistence.observe(() =>
        this.deps.sessions.touchActivity(e.stream, new Date(now).toISOString()),
      );
    }
    if (e.term !== 'agent') return;
    if (live.status === 'starting') {
      live.status = 'running';
      this.observeTransition(e.stream, 'running');
    }
    live.detector?.feed(e.data);
    if (live.detector === null) this.terminalAgents.feed(e.stream, e.data);
    // A session announces a name change by setting its terminal title (OSC
    // 0/1/2) — e.g. Claude Code's `/rename`, handled client-side with no status
    // transition. `extractOscTitle` returns the de-animated title (spinner
    // glyphs stripped) or null (SPEC §4).
    const oscTitle = extractOscTitle(e.data);
    if (oscTitle !== null) {
      // The "sequence" name: the default label for sessions without an
      // adapter-maintained agent_title (terminals, agents whose adapter has no
      // sessionTitle). Persist only on a real change — already de-animated.
      if (oscTitle !== live.lastOscTitle) {
        live.lastOscTitle = oscTitle;
        this.captureOscTitle(e.stream, oscTitle);
      }
      // For an adapter that keeps its own name (Claude Code → transcript), the
      // title emission is the cue to re-read it; throttled, transcript wins.
      if (now - live.lastTitleCheck > 1000) {
        live.lastTitleCheck = now;
        this.refreshAgentIdentity(e.stream);
      }
    }
  }

  /**
   * Stores the terminal-title "sequence" name and broadcasts a `renamed` so an
   * attached client's default label tracks it live. A user `title` and an
   * adapter's `agent_title` both still win in the display order (SPEC §4).
   * Best-effort: never throws upward.
   */
  private captureOscTitle(sessionId: string, oscTitle: string): void {
    let session: Session;
    try {
      session = this.deps.sessions.get(sessionId);
    } catch {
      return; // session gone
    }
    if ((session.osc_title ?? null) === oscTitle) return; // already current
    this.deps.sessions.setOscTitle(sessionId, oscTitle);
    this.emit('renamed', {
      session: sessionId,
      title: session.title,
      agent_title: session.agent_title ?? null,
      osc_title: oscTitle,
    } satisfies RenameEvent);
  }

  /**
   * The daemon's bound port, learnt after listen — from then on every agent
   * spawn carries the /agent-signal env pair (see spawnAgent).
   */
  setSignalPort(port: number): void {
    this.signalPort = port;
  }

  /** This session's live signal nonce (tests/diagnostics), or null. */
  signalNonceFor(sessionId: string): string | null {
    return this.liveAgents.get(sessionId)?.signalNonce ?? null;
  }

  /**
   * POST /agent-signal (SPEC §4): an agent hook reports its own state. The
   * nonce is the auth — unknown or stale (PTY exited) → false, and the route
   * 404s without leaking whether the nonce ever existed. The first signal
   * flips the session to hooks-are-authoritative (see LiveAgent.signalled).
   */
  signalAgentStatus(nonce: string, state: 'working' | 'waiting_input'): boolean {
    const live = this.signalNonces.get(nonce);
    if (!live || !this.runtimes.has(live.runtimeId)) return false;
    const sessionId = live.activeSessionId;
    live.signalled = true;
    this.onDetected(sessionId, state === 'working' ? 'running' : 'waiting_input', 'signal');
    return true;
  }

  signalAgentTurn(signal: AgentTurnSignal): boolean {
    const live = this.signalNonces.get(signal.nonce);
    if (!live || !this.runtimes.has(live.runtimeId) || !live.lifecycleResource?.control?.signal)
      return false;
    const state = live.lifecycleResource.control.signal(signal);
    if (state) this.signalAgentStatus(signal.nonce, state);
    return true;
  }

  /**
   * Consume an exact top-level native lifecycle event. Compact and initial
   * startup only refresh identity; clear/resume/fork may atomically move the
   * stable runtime to another immutable Puddle placement.
   */
  async signalAgentLifecycle(signal: LifecycleSignal): Promise<boolean> {
    const runtime = this.signalNonces.get(signal.nonce);
    if (!runtime || !this.runtimes.has(runtime.runtimeId)) return false;
    return this.lifecycleMutex.run('native-conversation-switch', async () => {
      if (!this.runtimes.has(runtime.runtimeId)) return false;
      const sourceId = runtime.activeSessionId;
      const source = this.deps.sessions.get(sourceId);
      runtime.lifecycleResource?.control?.lifecycle?.(
        signal.agent_session_ref,
        signal.event === 'session_end',
      );
      if (signal.event === 'session_end') {
        this.deps.events.record(sourceId, 'native_session_end', {
          source: signal.source,
          ref: signal.agent_session_ref ?? source.agent_session_ref,
        });
        return true;
      }
      if (!signal.agent_session_ref || source.account_id === null || source.agent_type === null) {
        return true;
      }
      const account = this.deps.accounts.get(source.account_id);
      const project = this.deps.projects.get(source.project_id);
      const parentRef =
        signal.parent_agent_session_ref ??
        (signal.source === 'fork' ? (source.agent_session_ref ?? undefined) : undefined);
      const conversation = this.deps.conversations.upsert(
        project.profile_id,
        source.agent_type,
        account.id,
        {
          ref: signal.agent_session_ref,
          cwd: signal.cwd,
          ...(signal.native_title !== undefined ? { title: signal.native_title } : {}),
          ...(parentRef !== undefined ? { parentRef } : {}),
          ...(signal.native_created_at !== undefined
            ? { createdAt: signal.native_created_at }
            : {}),
          ...(signal.native_updated_at !== undefined
            ? { updatedAt: signal.native_updated_at }
            : {}),
        },
      );
      // An exact event proves which account currently owns the native
      // conversation, unlike catalogue polling of a profile-shared store.
      this.deps.conversations.setPreferredAccount(conversation.id, account.id);

      const sameConversation = source.conversation_id === conversation.id;
      if (signal.source === 'compact' || sameConversation) {
        if (!sameConversation && source.conversation_id == null) {
          this.deps.sessions.setConversation(sourceId, conversation.id);
        }
        this.bindRuntimeConversation(sourceId);
        this.deps.sessions.setNativeSync(sourceId, 'full');
        return true;
      }
      if (!['clear', 'resume', 'fork'].includes(signal.source)) {
        if (source.conversation_id == null) {
          this.deps.sessions.setConversation(sourceId, conversation.id);
          this.bindRuntimeConversation(sourceId);
        }
        this.deps.sessions.setNativeSync(sourceId, 'full');
        return true;
      }

      const cause = signal.source as SessionSwitchEvent['cause'];
      const existingRuntime = this.conversationRuntimes.get(conversation.id);
      if (existingRuntime && existingRuntime !== runtime) {
        const target = this.deps.sessions.get(existingRuntime.activeSessionId);
        this.expectExit(sourceId);
        this.deps.ptys.killAll(sourceId);
        if (LIVE_STATUSES.includes(source.status)) this.transition(sourceId, 'exited');
        this.deps.events.record(sourceId, 'native_switch_conflict', {
          cause,
          target_session: target.id,
          target_project: target.project_id,
        });
        this.emit('session-switched', {
          sourceSession: sourceId,
          targetSession: target.id,
          targetProject: target.project_id,
          cause,
          outcome: 'focused-existing',
        } satisfies SessionSwitchEvent);
        return true;
      }

      const canonicalPath = this.deps.sessions.canonicalWorktreePath(sourceId);
      let targetId = this.deps.conversations.placement(
        conversation.id,
        source.project_id,
        canonicalPath,
      );
      if (targetId === null) {
        targetId = randomUUID();
        this.deps.sessions.create({
          id: targetId,
          project_id: source.project_id,
          account_id: source.account_id,
          conversation_id: conversation.id,
          worktree_path: source.worktree_path,
          base_branch: source.base_branch,
          branch: source.branch,
          separate_branch: source.separate_branch,
          branch_owned: false,
          kind: 'agent',
          agent_type: source.agent_type,
          title: null,
          status: 'exited',
          native_sync: 'full',
          skip_permissions: source.skip_permissions,
        });
      }
      if (targetId === sourceId) {
        this.bindRuntimeConversation(sourceId);
        return true;
      }

      this.deps.sessions.adoptRuntimeState(sourceId, targetId);
      this.deps.sessions.transferBranchOwnership(sourceId, targetId);
      this.liveAgents.delete(sourceId);
      this.liveAgents.set(targetId, runtime);
      runtime.activeSessionId = targetId;
      if (runtime.conversationId !== null) {
        const indexed = this.conversationRuntimes.get(runtime.conversationId);
        if (indexed === runtime) this.conversationRuntimes.delete(runtime.conversationId);
      }
      runtime.conversationId = conversation.id;
      this.conversationRuntimes.set(conversation.id, runtime);
      try {
        await this.deps.ptys.rebindStream(sourceId, targetId);
      } catch (error) {
        this.liveAgents.delete(targetId);
        this.liveAgents.set(sourceId, runtime);
        runtime.activeSessionId = sourceId;
        throw error;
      }
      this.deps.onboarding.unwatch(sourceId);
      this.adopted.delete(sourceId);
      this.transition(sourceId, 'exited');
      const runtimeStillLive = this.runtimes.has(runtime.runtimeId);
      if (runtimeStillLive) this.transition(targetId, runtime.status);
      this.deps.onboarding.watch(targetId, project.repo_id, source.worktree_path);
      if (runtimeStillLive) this.deps.ptys.redraw(targetId, 'agent');
      this.deps.events.record(sourceId, 'native_switched_away', {
        cause,
        target_session: targetId,
        conversation_id: conversation.id,
      });
      this.deps.events.record(targetId, 'native_switched_to', {
        cause,
        source_session: sourceId,
        conversation_id: conversation.id,
      });
      this.emit('session-switched', {
        sourceSession: sourceId,
        targetSession: targetId,
        targetProject: source.project_id,
        cause,
        outcome: 'rebound',
      } satisfies SessionSwitchEvent);
      return true;
    });
  }

  private bindRuntimeConversation(sessionId: string): void {
    const runtime = this.liveAgents.get(sessionId);
    if (!runtime) return;
    const conversationId = this.deps.sessions.get(sessionId).conversation_id ?? null;
    if (runtime.conversationId !== null && runtime.conversationId !== conversationId) {
      const indexed = this.conversationRuntimes.get(runtime.conversationId);
      if (indexed === runtime) this.conversationRuntimes.delete(runtime.conversationId);
    }
    runtime.conversationId = conversationId;
    if (conversationId === null) return;
    const existing = this.conversationRuntimes.get(conversationId);
    if (existing && existing !== runtime) {
      this.emit('notice', {
        level: 'warning',
        title: 'Conversation already running',
        detail: 'A duplicate runtime was stopped to keep native conversation ownership unique.',
        session: sessionId,
      } satisfies NoticeEvent);
      this.expectExit(sessionId);
      this.deps.ptys.killAll(sessionId);
      return;
    }
    this.conversationRuntimes.set(conversationId, runtime);
  }

  private onDetected(
    sessionId: string,
    detected: DetectedStatus,
    source: 'detector' | 'signal' = 'detector',
  ): void {
    const live = this.liveAgents.get(sessionId);
    if (!live || live.status === detected) return;
    // Regex output cannot establish an idle state before the PTY has produced
    // its first chunk. An authoritative hook can: Claude's first Stop hook may
    // beat its first visible TUI draw, and dropping it leaves the session amber
    // until another hook happens to fire.
    if (live.status === 'starting' && source === 'detector') return;
    // Once hooks have spoken, the regex detector no longer drives status —
    // its output-based flips misread idle TUI redraws as activity.
    if (source === 'detector' && live.signalled) return;
    live.status = detected;
    this.observeTransition(sessionId, detected);
    // Backstop for adoption: by waiting_input the agent has written its
    // conversation file, which was usually absent at spawn time.
    if (detected === 'waiting_input') {
      this.scheduleAdopt(sessionId);
      this.notifyAgent(sessionId, 'waiting_input');
    }
    // The agent's own name lands in (and updates within) the transcript as the
    // conversation progresses; pick it up on each status change.
    this.refreshAgentIdentity(sessionId);
  }

  /**
   * Best-effort adopt of a session's conversation into the shared store. Runs
   * at most once successfully per session (the `adopted` set); a run that finds
   * nothing on disk yet leaves the session out so a later flip retries.
   */
  private scheduleAdopt(sessionId: string): void {
    if (!this.deps.share || this.adopted.has(sessionId)) return;
    let session;
    try {
      session = this.deps.sessions.get(sessionId);
    } catch {
      return; // session gone
    }
    void this.deps.share
      .adoptIfNeeded(session)
      .then((done) => {
        if (done) this.adopted.add(sessionId);
      })
      .catch((e) =>
        console.warn(`conversation adopt ${sessionId} failed: ${(e as Error).message}`),
      );
  }

  private onPtyExit(e: PtyExitEvent): void {
    const live = this.liveAgents.get(e.stream);
    // Shells have no agent state to tear down, but a shell dying on its own is
    // still something the user should hear about.
    if (e.term !== 'agent') {
      this.noticeOnAbnormalExit(e, false);
      return;
    }
    if (!live) return;
    const startupFailure = Date.now() - live.startedAt < STARTUP_FAILURE_MS;
    live.detector?.dispose();
    if (live.signalNonce !== null) this.signalNonces.delete(live.signalNonce);
    this.deps.ptys.unregisterSidecars(e.stream);
    void live.lifecycleResource?.dispose();
    this.runtimes.delete(live.runtimeId);
    if (
      live.conversationId !== null &&
      this.conversationRuntimes.get(live.conversationId) === live
    ) {
      this.conversationRuntimes.delete(live.conversationId);
    }
    this.liveAgents.delete(e.stream);
    if (this.shuttingDown) return; // reconcile turns these into `interrupted` next boot
    const expected =
      this.expectedExits.has(e.stream) || this.expectedExits.has(`${e.stream}:agent`);
    if (!expected) {
      if (live.detector === null) this.terminalAgents.exited(e.stream);
      else this.notifyAgent(e.stream, 'exited');
    }
    this.observeTransition(e.stream, 'exited', e.exitCode);
    this.terminalAgents.forget(e.stream);
    this.refreshAgentIdentity(e.stream); // capture the final ref/name for the durable row
    this.noticeOnAbnormalExit(e, startupFailure);
    this.expectedExits.delete(e.stream);
    this.expectedExits.delete(`${e.stream}:agent`);
  }

  /**
   * Turns an unexpected non-zero exit into a user-visible notice (SPEC §4).
   * Errors used to be silent here: a bad flag or a failed auth killed the
   * process in milliseconds, and unless the user happened to be looking at
   * that exact terminal they saw nothing at all.
   *
   * Deliberately quiet for exits we asked for (kill, archive, delete, shell
   * close, shutdown) and for clean ones — a notice the user learns to ignore
   * is worse than no notice.
   */
  private noticeOnAbnormalExit(e: PtyExitEvent, startupFailure: boolean): void {
    if (this.shuttingDown || e.exitCode === 0) return;
    if (this.expectedExits.delete(`${e.stream}:${e.term}`)) return;
    // A whole-session stop covers every term, so the flag is consumed by the
    // agent's exit rather than the first shell's — otherwise it would linger
    // and silence a genuine crash after the next resume.
    if (this.expectedExits.has(e.stream)) {
      if (e.term === 'agent') this.expectedExits.delete(e.stream);
      return;
    }
    const label = e.term === 'agent' ? 'Agent' : 'Terminal';
    this.emit('notice', {
      level: 'error',
      title: startupFailure
        ? `${label} failed to start (exit ${e.exitCode})`
        : `${label} exited unexpectedly (exit ${e.exitCode})`,
      detail: this.exitDetail(e),
      session: e.stream,
      term: e.term,
    } satisfies NoticeEvent);
  }

  /** The last few lines the process printed — usually the whole diagnosis. */
  private exitDetail(e: PtyExitEvent): string | undefined {
    let tail: string;
    try {
      tail = stripAnsi(this.deps.logs.readTail(e.stream, e.term));
    } catch {
      return undefined;
    }
    const lines = tail
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== '');
    if (lines.length === 0) return undefined;
    return lines.slice(-4).join('\n').slice(-400);
  }

  /**
   * Marks a stream (or one term of it) as being stopped on purpose, so its
   * exit does not raise a notice. Cleared by the matching exit.
   */
  expectExit(stream: string, term?: string): void {
    this.expectedExits.add(term === undefined ? stream : `${stream}:${term}`);
  }

  private notifyAgent(session: string, reason: AgentNotification['reason']): void {
    if (this.shuttingDown) return;
    this.refreshAgentTitle(session);
    const event: AgentNotification = {
      t: 'agent-notification',
      id: randomUUID(),
      session,
      reason,
    };
    const placement = this.deps.sessions.get(session);
    void notificationContent(placement, reason, this.deps)
      .then((content) => {
        if (!this.shuttingDown)
          this.emit('agent-notification', { ...event, content } satisfies AgentNotification);
      })
      .catch(() => {
        if (!this.shuttingDown) this.emit('agent-notification', event);
      });
  }

  private transition(id: string, status: SessionStatus): void {
    const s = this.deps.sessions.setStatus(id, status);
    this.persistence.forget(id);
    this.emit('status', {
      session: id,
      status,
      last_activity_at: s.last_activity_at,
    } satisfies StatusEvent);
  }

  private observeTransition(id: string, status: SessionStatus, exitCode?: number): void {
    this.persistence.save(id, { status, ...(exitCode !== undefined ? { exitCode } : {}) });
    const s = this.deps.sessions.get(id);
    this.emit('status', {
      session: id,
      status,
      last_activity_at: s.last_activity_at,
    } satisfies StatusEvent);
  }

  /** Worktree-missing and stale-running badges are computed, never stored (SPEC §4). */
  private withComputed(session: Session): Session {
    const pending = this.persistence.state(session.id);
    if (pending) session = { ...session, status: pending.status, persistence_pending: true };
    if (session.kind === 'terminal') {
      const live = this.liveAgents.get(session.id);
      session = {
        ...session,
        detected_agent_type: live ? this.terminalAgents.get(session.id, live.runtimeId) : null,
      };
    }
    if (session.status === 'archived') return session;
    const computed = existsSync(session.worktree_path)
      ? session
      : { ...session, worktree_missing: true };
    return this.staleRunning(computed) ? { ...computed, stale_running: true } : computed;
  }

  /** See STALE_RUNNING_MS. Best-effort: any failure reads as "not stale". */
  private staleRunning(session: Session): boolean {
    if (
      session.status !== 'running' ||
      session.kind !== 'agent' ||
      !session.agent_session_ref ||
      session.account_id === null ||
      !this.liveAgents.has(session.id)
    )
      return false;
    try {
      const account = this.deps.accounts.get(session.account_id);
      const adapter = this.deps.adapters.get(session.agent_type ?? account.agent_type);
      const activityAt = adapter.sessionActivityAt?.(session.agent_session_ref, account);
      return activityAt !== null && activityAt !== undefined
        ? Date.now() - activityAt.getTime() > STALE_RUNNING_MS
        : false;
    } catch {
      return false;
    }
  }
}
