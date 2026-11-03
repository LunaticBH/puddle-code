import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { realpathSync, watch, type FSWatcher } from 'node:fs';
import type { Account, Repo } from '@puddle/shared';
import type { AdapterRegistry } from '../agents/registry.js';
import type { AccountStore } from '../db/stores/accounts.js';
import {
  type AgentConversation,
  type ConversationStore,
  type NativeConversationMetadata,
} from '../db/stores/conversations.js';
import type { ProjectStore } from '../db/stores/projects.js';
import type { RepoStore } from '../db/stores/repos.js';
import type { SessionStore } from '../db/stores/sessions.js';
import { git } from '../git/exec.js';
import { gitMutexKey } from '../git/mutex.js';
import { canonicalHostPath, sameHostPath } from '../host-path.js';
import type { WorktreeManager } from '../worktrees/manager.js';

const WATCH_DEBOUNCE_MS = 250;
const HEALTHY_SWEEP_MS = 5 * 60_000;
const FALLBACK_MIN_MS = 15_000;
const FALLBACK_MAX_MS = 5 * 60_000;
const DELETION_VERIFY_MS = 1_500;

interface WatchState {
  watchers: FSWatcher[];
  healthy: boolean;
  debounce: ReturnType<typeof setTimeout> | null;
  verification: ReturnType<typeof setTimeout> | null;
  fallback: ReturnType<typeof setTimeout> | null;
  fallbackDelay: number;
  signature: string | null;
}

export interface SessionsChangedEvent {
  projectIds: string[];
}

/**
 * Activation-driven, watched native conversation catalogue. Adapters own
 * storage parsing; this coordinator owns profile/project eligibility,
 * coalescing, missing confirmation, and placement materialisation.
 */
export class ConversationCatalogue extends EventEmitter {
  private readonly states = new Map<number, WatchState>();
  private readonly scans = new Map<number, Promise<void>>();
  private readonly repoKeys = new Map<number, Promise<string>>();
  private readonly safetyTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly deps: {
      accounts: AccountStore;
      conversations: ConversationStore;
      projects: ProjectStore;
      repos: RepoStore;
      sessions: SessionStore;
      adapters: AdapterRegistry;
      worktrees: WorktreeManager;
    },
    private readonly timings: {
      watchDebounceMs?: number;
      healthySweepMs?: number;
      fallbackMinMs?: number;
      fallbackMaxMs?: number;
      deletionVerifyMs?: number;
      /** Deterministic watch backend for battery/debounce tests. */
      watchFactory?: (root: string, listener: () => void) => FSWatcher;
    } = {},
  ) {
    super();
    this.reconcileWatchers();
    this.safetyTimer = setInterval(() => {
      this.reconcileWatchers();
      for (const [accountId, state] of this.states) {
        if (state.healthy) void this.scan(accountId, false);
      }
    }, timings.healthySweepMs ?? HEALTHY_SWEEP_MS);
    this.safetyTimer.unref?.();
  }

  /** Project transition/unarchive trigger. Calls coalesce per account. */
  refreshProject(projectId: string): void {
    const project = this.deps.projects.get(projectId);
    if (project.archived) return;
    this.reconcileWatchers();
    for (const account of this.deps.accounts.list(project.profile_id)) {
      if (!this.deps.adapters.get(account.agent_type).conversationDiscovery) continue;
      void this.scan(account.id, false);
    }
  }

  dispose(): void {
    clearInterval(this.safetyTimer);
    for (const state of this.states.values()) this.disposeState(state);
    this.states.clear();
  }

  /** Accounts with no non-archived project install no watchers. */
  reconcileWatchers(): void {
    const eligibleProfiles = new Set(
      this.deps.projects
        .list()
        .filter((project) => !project.archived)
        .map((project) => project.profile_id),
    );
    const eligible = new Set<number>();
    for (const account of this.deps.accounts.list()) {
      if (!eligibleProfiles.has(account.profile_id)) continue;
      const discovery = this.deps.adapters.get(account.agent_type).conversationDiscovery;
      if (!discovery) continue;
      eligible.add(account.id);
      if (!this.states.has(account.id)) this.installWatchers(account);
    }
    for (const [accountId, state] of [...this.states]) {
      if (eligible.has(accountId)) continue;
      this.disposeState(state);
      this.states.delete(accountId);
    }
  }

  private installWatchers(account: Account): void {
    const discovery = this.deps.adapters.get(account.agent_type).conversationDiscovery!;
    const state: WatchState = {
      watchers: [],
      healthy: true,
      debounce: null,
      verification: null,
      fallback: null,
      fallbackDelay: this.timings.fallbackMinMs ?? FALLBACK_MIN_MS,
      signature: null,
    };
    this.states.set(account.id, state);
    for (const root of discovery.watchRoots(account)) {
      try {
        const listener = () => this.onWatchEvent(account.id);
        const watcher = this.timings.watchFactory
          ? this.timings.watchFactory(root, listener)
          : watch(root, { persistent: false }, listener);
        watcher.on('error', () => this.markWatchFailed(account.id));
        state.watchers.push(watcher);
      } catch {
        state.healthy = false;
      }
    }
    if (state.watchers.length === 0) state.healthy = false;
    if (!state.healthy) this.scheduleFallback(account.id);
  }

  private onWatchEvent(accountId: number): void {
    const state = this.states.get(accountId);
    if (!state) return;
    if (state.debounce) clearTimeout(state.debounce);
    state.debounce = setTimeout(() => {
      state.debounce = null;
      void this.scan(accountId, true);
    }, this.timings.watchDebounceMs ?? WATCH_DEBOUNCE_MS);
    state.debounce.unref?.();
  }

  private markWatchFailed(accountId: number): void {
    const state = this.states.get(accountId);
    if (!state || !state.healthy) return;
    state.healthy = false;
    for (const watcher of state.watchers) watcher.close();
    state.watchers = [];
    this.scheduleFallback(accountId);
  }

  private scheduleFallback(accountId: number): void {
    const state = this.states.get(accountId);
    if (!state || state.healthy || state.fallback) return;
    state.fallback = setTimeout(() => {
      state.fallback = null;
      void this.scan(accountId, false).finally(() => this.scheduleFallback(accountId));
    }, state.fallbackDelay);
    state.fallback.unref?.();
  }

  private scan(accountId: number, eventTriggered: boolean): Promise<void> {
    const active = this.scans.get(accountId);
    if (active) {
      if (eventTriggered) void active.finally(() => this.scheduleDeletionVerification(accountId));
      return active;
    }
    const pending = this.scanCore(accountId, eventTriggered)
      .catch((error) => {
        // Catalogue upkeep is background work. A failed pass may have refreshed
        // rows it did read, but it must never advance deletion state or become
        // an unhandled rejection that destabilises the daemon.
        console.warn(
          `conversation scan failed for account ${accountId}: ${(error as Error).message}`,
        );
      })
      .finally(() => {
        if (this.scans.get(accountId) === pending) this.scans.delete(accountId);
      });
    this.scans.set(accountId, pending);
    return pending;
  }

  private async scanCore(accountId: number, eventTriggered: boolean): Promise<void> {
    let account: Account;
    try {
      account = this.deps.accounts.get(accountId);
    } catch {
      return;
    }
    const discovery = this.deps.adapters.get(account.agent_type).conversationDiscovery;
    if (!discovery) return;
    let native: Awaited<ReturnType<typeof discovery.discover>>;
    try {
      native = await discovery.discover(account);
    } catch (error) {
      // Failed scans never advance missing state.
      console.warn(
        `conversation scan failed for account ${accountId}: ${(error as Error).message}`,
      );
      return;
    }

    const changedProjects = new Set<string>();
    const seenRefs = new Set<string>();
    for (const metadata of native) {
      seenRefs.add(metadata.ref);
      const before = this.deps.conversations.getByRef(
        account.profile_id,
        account.agent_type,
        metadata.ref,
      );
      const conversation = this.deps.conversations.upsert(
        account.profile_id,
        account.agent_type,
        account.id,
        metadata,
      );
      if (
        before &&
        (before.native_title !== conversation.native_title ||
          before.parent_conversation_id !== conversation.parent_conversation_id ||
          before.missing !== conversation.missing)
      ) {
        for (const sessionId of this.deps.conversations.placements(conversation.id)) {
          changedProjects.add(this.deps.sessions.get(sessionId).project_id);
        }
      }
      for (const projectId of await this.materialisePlacements(account, conversation, metadata)) {
        changedProjects.add(projectId);
      }
    }
    for (const conversationId of this.deps.conversations.completeSuccessfulScan(
      account.id,
      seenRefs,
    )) {
      for (const sessionId of this.deps.conversations.placements(conversationId)) {
        changedProjects.add(this.deps.sessions.get(sessionId).project_id);
      }
    }

    const signature = JSON.stringify(
      native.map((row) => [row.ref, row.cwd, row.title, row.parentRef, row.updatedAt]),
    );
    const state = this.states.get(account.id);
    if (state && !state.healthy) {
      state.fallbackDelay =
        state.signature === signature
          ? Math.min(state.fallbackDelay * 2, this.timings.fallbackMaxMs ?? FALLBACK_MAX_MS)
          : (this.timings.fallbackMinMs ?? FALLBACK_MIN_MS);
      state.signature = signature;
    }

    if (changedProjects.size > 0) {
      this.emit('sessions-changed', {
        projectIds: [...changedProjects],
      } satisfies SessionsChangedEvent);
    }
    // A watch event may be the deletion itself. One short successful follow-up
    // confirms it without waiting for the five-minute safety sweep.
    if (eventTriggered) this.scheduleDeletionVerification(account.id);
  }

  private scheduleDeletionVerification(accountId: number): void {
    const state = this.states.get(accountId);
    if (!state || state.verification) return;
    state.verification = setTimeout(() => {
      const current = this.states.get(accountId);
      if (current !== state) return;
      state.verification = null;
      void this.scan(accountId, false);
    }, this.timings.deletionVerifyMs ?? DELETION_VERIFY_MS);
    state.verification.unref?.();
  }

  private async materialisePlacements(
    account: Account,
    conversation: AgentConversation,
    metadata: NativeConversationMetadata,
  ): Promise<string[]> {
    const mapped = await this.mapCwd(metadata.cwd);
    if (!mapped) return [];
    const projects = this.deps.projects
      .list(account.profile_id)
      .filter((project) => !project.archived && project.repo_id === mapped.repo.id);
    const created: string[] = [];
    for (const project of projects) {
      if (this.deps.conversations.placement(conversation.id, project.id, mapped.canonicalPath)) {
        continue;
      }
      this.deps.sessions.create({
        id: randomUUID(),
        project_id: project.id,
        account_id: conversation.preferred_account_id ?? account.id,
        conversation_id: conversation.id,
        worktree_path: mapped.worktreePath,
        base_branch: mapped.branch,
        branch: mapped.branch,
        separate_branch: false,
        branch_owned: false,
        kind: 'agent',
        agent_type: conversation.agent_type,
        title: null,
        status: 'exited',
        native_sync: 'pending',
        skip_permissions: false,
      });
      created.push(project.id);
    }
    return created;
  }

  /** Native cwd → containing registered canonical Git worktree. */
  private async mapCwd(
    cwd: string,
  ): Promise<{ repo: Repo; worktreePath: string; canonicalPath: string; branch: string } | null> {
    let worktreePath: string;
    let commonKey: string;
    try {
      worktreePath = await git(['rev-parse', '--show-toplevel'], { cwd });
      commonKey = await gitMutexKey(worktreePath);
    } catch {
      return null;
    }
    for (const repo of this.deps.repos.list()) {
      const key = this.repoKeys.get(repo.id) ?? gitMutexKey(repo.path);
      this.repoKeys.set(repo.id, Promise.resolve(key));
      let repoKey: string;
      try {
        repoKey = await key;
      } catch {
        continue;
      }
      if (repoKey !== commonKey) continue;
      const canonicalPath = this.realOf(worktreePath);
      const exposed = (await this.deps.worktrees.listWorktrees(repo)).find((worktree) =>
        sameHostPath(this.realOf(worktree.path), canonicalPath),
      );
      if (!exposed?.branch) return null;
      return {
        repo,
        worktreePath: exposed.path,
        canonicalPath,
        branch: exposed.branch,
      };
    }
    return null;
  }

  /** Git prints `C:/…` on Windows: there the canonical host spelling is compared instead. */
  private realOf(path: string): string {
    if (process.platform === 'win32') return canonicalHostPath(path);
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  }

  private disposeState(state: WatchState): void {
    for (const watcher of state.watchers) watcher.close();
    if (state.debounce) clearTimeout(state.debounce);
    if (state.verification) clearTimeout(state.verification);
    if (state.fallback) clearTimeout(state.fallback);
  }
}
