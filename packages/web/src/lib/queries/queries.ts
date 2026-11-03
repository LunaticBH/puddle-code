import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  Account,
  AccountUsage,
  AgentType,
  CreateSessionRequest,
  DaemonConfig,
  DaemonConfigPatch,
  FsDirsResponse,
  HostInfo,
  LoginResponse,
  Profile,
  ProfileSettings,
  Project,
  CreateProjectRequest,
  PatchProjectRequest,
  ProjectDetail,
  ScratchpadEntry,
  CreateScratchpadRequest,
  PatchScratchpadRequest,
  SavedLayout,
  CreateLayoutRequest,
  PatchLayoutRequest,
  UiStateResponse,
  RepoBranchesResponse,
  RepoWithOrphans,
  RepoWorktreesResponse,
  Session,
  SessionEnvResponse,
  ClearSessionEnvResponse,
  SessionPortsResponse,
  UiStateSnapshot,
  VersionResponse,
} from '@puddle/shared';
import { api } from '../transport/api';
import { focusAwareInterval } from './poll-focus';

/** TanStack Query hooks per daemon resource. Types come from @puddle/shared. */

export function useProfiles() {
  return useQuery({
    queryKey: ['profiles'],
    queryFn: () => api<Profile[]>('GET', '/api/profiles'),
  });
}

export function useProfileSettings(profileId: string | undefined) {
  return useQuery({
    queryKey: ['profile-settings', profileId],
    queryFn: () => api<ProfileSettings>('GET', `/api/profiles/${profileId}/settings`),
    enabled: profileId !== undefined,
  });
}

export function useAccounts(profileId: string | undefined) {
  return useQuery({
    queryKey: ['accounts', profileId],
    queryFn: () => api<Account[]>('GET', `/api/accounts?profile=${profileId}`),
    enabled: profileId !== undefined,
  });
}

export function useAccountUsage(accountId: number | undefined) {
  return useQuery({
    queryKey: ['account-usage', accountId],
    queryFn: () => api<AccountUsage>('GET', `/api/accounts/${accountId}/usage`),
    enabled: accountId !== undefined,
    staleTime: 15_000,
  });
}

export function useRepos() {
  return useQuery({
    queryKey: ['repos'],
    queryFn: () => api<RepoWithOrphans[]>('GET', '/api/repos'),
  });
}

/** All projects when profileId is undefined (the "everyone" view). */
export function useProjects(profileId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['projects', profileId ?? 'all'],
    queryFn: () =>
      api<Project[]>(
        'GET',
        profileId === undefined ? '/api/projects' : `/api/projects?profile=${profileId}`,
      ),
    enabled,
  });
}

/**
 * `placeholderData` keeps the PREVIOUS project's detail on screen while the next
 * one is in flight, so switching projects never unmounts the workspace: without
 * it the loading gate replaced the whole shell for the length of one fetch,
 * which tore down every open terminal (they re-attach, but the flash cost their
 * viewport) and — worse — pulled the sidebar out from under a double-click
 * mid-gesture. Consumers must therefore check `project.id` before trusting the
 * data for the project in the URL; `Workspace` does.
 */
export function useProjectDetail(projectId: string | undefined) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectDetail>('GET', `/api/projects/${projectId}`),
    enabled: projectId !== undefined,
    placeholderData: (previous) => previous,
  });
}

/** Activation-driven native catalogue refresh; discovery continues asynchronously. */
export function refreshProjectConversations(projectId: string): Promise<void> {
  return api<void>('POST', `/api/projects/${projectId}/conversations/refresh`);
}

export function useSessions(projectId: string | undefined) {
  return useQuery({
    queryKey: ['sessions', projectId],
    queryFn: () => api<Session[]>('GET', `/api/sessions?project=${projectId}`),
    enabled: projectId !== undefined,
  });
}

/**
 * Every session on the daemon, whatever the profile (trusted shared box). The
 * profile-keyed layout tree can hold tabs from any project the viewer opened,
 * so tab labels, status dots, restore-time pruning, and the cross-project
 * sidebar (which filters per project) all derive from this one list. Keyed
 * under `['sessions', …]` so the live status/rename sync patches it too.
 */
const allSessionsQuery = {
  queryKey: ['sessions', 'all'],
  queryFn: () => api<Session[]>('GET', '/api/sessions'),
};

export function useAllSessions(enabled = true) {
  return useQuery({ ...allSessionsQuery, enabled });
}

/**
 * Imperative fetch of the same list, through the same cache entry — for code
 * outside the hook tree (the waiting-input notifier, whose session may not be
 * in any mounted query's cache).
 */
export function fetchAllSessions(qc: QueryClient): Promise<Session[]> {
  return qc.fetchQuery(allSessionsQuery);
}

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: () => api<DaemonConfig>('GET', '/api/config') });
}

export function useRepoBranches(repoId: number | undefined) {
  return useQuery({
    queryKey: ['repo-branches', repoId],
    queryFn: () => api<RepoBranchesResponse>('GET', `/api/repos/${repoId}/branches`),
    enabled: repoId !== undefined,
    staleTime: 30_000,
  });
}

/** Every git worktree currently checked out for a repo (SPEC §4, join_worktree). */
export function useRepoWorktrees(repoId: number | undefined, staleTime = 10_000) {
  return useQuery({
    queryKey: ['repo-worktrees', repoId],
    queryFn: () => api<RepoWorktreesResponse>('GET', `/api/repos/${repoId}/worktrees`),
    enabled: repoId !== undefined,
    staleTime,
  });
}

/**
 * Prune (remove) a worktree of a repo (SPEC §8). The branch is kept, so there
 * is no confirmation. Refreshes the worktree list and the project (a session
 * may now be "worktree missing").
 */
export function usePruneWorktree(repoId: number | undefined, projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) =>
      api<RepoWorktreesResponse>(
        'DELETE',
        `/api/repos/${repoId}/worktrees?path=${encodeURIComponent(path)}`,
      ),
    onSuccess: (res) => {
      qc.setQueryData(['repo-worktrees', repoId], res);
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
}

/**
 * Delete an orphaned local branch of a repo (SPEC §8): only branches with no
 * worktree; `confirm` is required by the daemon for a purely-local branch
 * (deleting it discards unpushed commits).
 */
export function useDeleteBranch(repoId: number | undefined, projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, confirm }: { name: string; confirm?: boolean }) => {
      const qs = new URLSearchParams({ name });
      if (confirm) qs.set('confirm', '1');
      return api<RepoWorktreesResponse>('DELETE', `/api/repos/${repoId}/branches?${qs.toString()}`);
    },
    onSuccess: (res) => {
      qc.setQueryData(['repo-worktrees', repoId], res);
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
}

export function useDirSuggestions(prefix: string) {
  return useQuery({
    queryKey: ['fs-dirs', prefix],
    queryFn: () => api<FsDirsResponse>('GET', `/api/fs/dirs?prefix=${encodeURIComponent(prefix)}`),
    enabled: prefix.startsWith('/') || prefix.startsWith('~'), // ~ expands on the host
    placeholderData: (previous) => previous, // keep the list steady while typing
    staleTime: 10_000,
  });
}

/**
 * The daemon's app + protocol version, for feature-detecting within a major
 * (PROTOCOL.md rule 3): a newer UI on an older daemon checks `protocol.minor`
 * and hides what the daemon cannot do.
 */
export function useDaemonVersion() {
  return useQuery({
    queryKey: ['version'],
    queryFn: () => api<VersionResponse>('GET', '/api/version'),
    staleTime: Infinity, // changes only with a daemon swap, which reloads the UI
  });
}

export function useHostInfo() {
  return useQuery({
    queryKey: ['host'],
    queryFn: () => api<HostInfo>('GET', '/api/host'),
    staleTime: Infinity, // the box does not change under a running daemon
  });
}

/** The machine's label: the user's display-name customisation, else its hostname. */
export function hostLabel(host: HostInfo | undefined): string | undefined {
  return host ? host.displayName || host.hostname : undefined;
}

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => api<AgentType[]>('GET', '/api/agents'),
    // The adapter set changes only with a daemon upgrade, but `available`
    // tracks whether each agent's CLI is on PATH — so installing one mid-session
    // must show up without a daemon restart or a reload.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/* -- Mutations ---------------------------------------------------------- */

export function useCreateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; branch_prefix?: string }) =>
      api<Profile>('POST', '/api/profiles', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['profiles'] }),
  });
}

export function usePatchProfileSettings(profileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<ProfileSettings>('PATCH', `/api/profiles/${profileId}/settings`, patch),
    onSuccess: (settings) => qc.setQueryData(['profile-settings', profileId], settings),
  });
}

export function usePatchProfile() {
  const qc = useQueryClient();
  return useMutation({
    // Send only the fields present; JSON.stringify drops the undefined ones.
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string;
      name?: string;
      branch_prefix?: string;
      icon?: string | null;
      icon_colour?: string | null;
    }) => api<Profile>('PATCH', `/api/profiles/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['profiles'] }),
  });
}

export function usePatchAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: number;
      label?: string;
      skip_permissions_default?: boolean;
    }) => api<Account>('PATCH', `/api/accounts/${id}`, patch),
    onSuccess: (account) => {
      void qc.invalidateQueries({ queryKey: ['accounts', account.profile_id] });
      void qc.invalidateQueries({ queryKey: ['account-usage', account.id] });
    },
  });
}

export function useDeleteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>('DELETE', `/api/profiles/${id}`),
    onSuccess: () => qc.clear(), // everything under the profile is gone
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>('DELETE', `/api/accounts/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['accounts'] }),
  });
}

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      profile_id: string;
      agent_type: string;
      label: string;
      skip_permissions_default?: boolean;
      import_dir?: string;
    }) => api<Account>('POST', '/api/accounts', body),
    onSuccess: (account) =>
      void qc.invalidateQueries({ queryKey: ['accounts', account.profile_id] }),
  });
}

export function useLoginAccount() {
  return useMutation({
    mutationFn: (accountId: number) =>
      api<LoginResponse>('POST', `/api/accounts/${accountId}/login`),
  });
}

export function useCreateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { path: string; default_base_branch?: string; onboarding_notes?: string }) =>
      api<RepoWithOrphans>('POST', '/api/repos', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}

export function usePatchRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number } & Record<string, unknown>) =>
      api<RepoWithOrphans>('PATCH', `/api/repos/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}

export function useFetchRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: number) => api<RepoWithOrphans>('POST', `/api/repos/${repoId}/fetch`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) => api<Project>('POST', '/api/projects', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

/** Edit appearance and/or archive a project (archive is a reversible hide, SPEC §11). */
export function usePatchProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: PatchProjectRequest & { id: string }) =>
      api<Project>('PATCH', `/api/projects/${id}`, patch),
    onSuccess: (project) => {
      qc.setQueryData<ProjectDetail>(['project', project.id], (detail) =>
        detail ? { ...detail, project } : detail,
      );
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/**
 * Scratchpad entries visible in the current context: profile-scoped ones plus
 * the current project's own (SPEC §11). Keyed by (profile, project) so
 * switching project refetches the project-scoped slice.
 */
export function useScratchpad(profileId: string | undefined, projectId: string | undefined) {
  return useQuery({
    queryKey: ['scratchpad', profileId, projectId ?? 'none'],
    queryFn: () =>
      api<ScratchpadEntry[]>(
        'GET',
        `/api/scratchpad?profile=${profileId}${projectId ? `&project=${projectId}` : ''}`,
      ),
    enabled: profileId !== undefined,
  });
}

export function useCreateScratchpad() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateScratchpadRequest) =>
      api<ScratchpadEntry>('POST', '/api/scratchpad', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['scratchpad'] }),
  });
}

export function usePatchScratchpad() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number } & PatchScratchpadRequest) =>
      api<ScratchpadEntry>('PATCH', `/api/scratchpad/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['scratchpad'] }),
  });
}

export function useDeleteScratchpad() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>('DELETE', `/api/scratchpad/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['scratchpad'] }),
  });
}

/**
 * Saved layouts visible in the current context (SPEC §11): profile-scoped ones
 * plus the current project's own — the same keying as the Scratchpad. Without
 * a project (the dashboard), every layout of the profile.
 */
export function useLayouts(profileId: string | undefined, projectId: string | undefined) {
  return useQuery({
    queryKey: ['layouts', profileId, projectId ?? 'none'],
    queryFn: () =>
      api<SavedLayout[]>(
        'GET',
        `/api/layouts?profile=${profileId}${projectId ? `&project=${projectId}` : ''}`,
      ),
    enabled: profileId !== undefined,
  });
}

export function useCreateLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLayoutRequest) => api<SavedLayout>('POST', '/api/layouts', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['layouts'] }),
  });
}

export function usePatchLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number } & PatchLayoutRequest) =>
      api<SavedLayout>('PATCH', `/api/layouts/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['layouts'] }),
  });
}

export function useDeleteLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>('DELETE', `/api/layouts/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['layouts'] }),
  });
}

function invalidateSessions(qc: ReturnType<typeof useQueryClient>, session: Session) {
  // Invalidate the whole `sessions` namespace, not just this project's key: the
  // cross-project sidebar reads `['sessions', 'profile', profileId]`, which a
  // `['sessions', projectId]` prefix would NOT match — so a fresh session (or a
  // rename/archive/kill/migrate) never showed there until a reload. The mutation
  // only has `project_id`, so the `['sessions']` prefix is the clean fix; it
  // still covers the per-project list too.
  void qc.invalidateQueries({ queryKey: ['sessions'] });
  void qc.invalidateQueries({ queryKey: ['project', session.project_id] });
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSessionRequest) => api<Session>('POST', '/api/sessions', body),
    onSuccess: (session) => invalidateSessions(qc, session),
  });
}

export function useSessionAction(action: 'resume' | 'kill') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api<Session>('POST', `/api/sessions/${sessionId}/${action}`),
    onSuccess: (session) => invalidateSessions(qc, session),
  });
}

/**
 * Tier-1 migration (SPEC §5/§6): move a session to another account of the same
 * (profile, agent) and resume it there. The conversation stays in the shared
 * store, so this only repoints `account_id` and resumes under the target.
 */
export function useMigrateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, accountId }: { sessionId: string; accountId: number }) =>
      api<Session>('POST', `/api/sessions/${sessionId}/migrate`, { account_id: accountId }),
    onSuccess: (session) => invalidateSessions(qc, session),
  });
}

/**
 * Tier-2 cross-agent hand-off (SPEC §5). Unlike migrate this RETURNS A NEW
 * SESSION — one created in the source's worktree on a different agent — so the
 * source's own queries are invalidated too, for its new linking event.
 */
export function useHandoffSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, accountId }: { sessionId: string; accountId: number }) =>
      api<Session>('POST', `/api/sessions/${sessionId}/handoff`, { account_id: accountId }),
    onSuccess: (created, { sessionId }) => {
      invalidateSessions(qc, created);
      void qc.invalidateQueries({ queryKey: ['session', sessionId] });
    },
  });
}

/**
 * Archive is now a reversible hide (SPEC §4): the worktree and conversation are
 * kept, so there is nothing to force or confirm — a bare POST hides the session.
 */
export function useArchiveSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api<Session>('POST', `/api/sessions/${sessionId}/archive`),
    onSuccess: (session) => invalidateSessions(qc, session),
  });
}

/** Reverse an archive: back to the active list, resumable if its worktree survives. */
export function useUnarchiveSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api<Session>('POST', `/api/sessions/${sessionId}/unarchive`),
    onSuccess: (session) => invalidateSessions(qc, session),
  });
}

export function useRenameSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) =>
      api<Session>('PATCH', `/api/sessions/${sessionId}`, { title }),
    onSuccess: (session) => invalidateSessions(qc, session),
  });
}

export function usePatchConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: DaemonConfigPatch) => api<DaemonConfig>('PATCH', '/api/config', patch),
    onSuccess: (config, patch) => {
      qc.setQueryData(['config'], config);
      // The host label mirrors config.displayName; refetch so it updates live.
      if ('displayName' in patch) void qc.invalidateQueries({ queryKey: ['host'] });
    },
  });
}

/* -- Workspace ui_state (SPEC §11 reload semantics) ---------------------- */

export async function fetchProfileState(profileId: string): Promise<UiStateResponse | null> {
  try {
    return await api<UiStateResponse>('GET', `/api/profiles/${profileId}/state`);
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'no_state') return null;
    throw e;
  }
}

export function putProfileState(
  profileId: string,
  uiState: UiStateSnapshot,
): Promise<UiStateResponse> {
  return api<UiStateResponse>('PUT', `/api/profiles/${profileId}/state`, { ui_state: uiState });
}

/**
 * Ports strip (SPEC §9): polls only while `live` (the active session is
 * `running`/`waiting_input`) — no refresh button, the 5s interval IS the
 * refresh; background tabs stop polling entirely and an unfocused window
 * slows down (poll-focus.ts).
 */
export function useSessionPorts(sessionId: string | undefined, live: boolean) {
  return useQuery({
    queryKey: ['ports', sessionId],
    queryFn: () => api<SessionPortsResponse>('GET', `/api/sessions/${sessionId}/ports`),
    enabled: sessionId !== undefined && live,
    refetchInterval: focusAwareInterval(5_000),
    refetchIntervalInBackground: false,
  });
}

/**
 * Captured env strip (SPEC §4): the session's captured vars for display and
 * value-copying. Mirrors useSessionPorts: polls only while live, the 5s
 * interval is the refresh.
 */
export function useSessionEnv(sessionId: string | undefined, live: boolean) {
  return useQuery({
    queryKey: ['session-env', sessionId],
    queryFn: () => api<SessionEnvResponse>('GET', `/api/sessions/${sessionId}/env`),
    enabled: sessionId !== undefined && live,
    refetchInterval: focusAwareInterval(5_000),
    refetchIntervalInBackground: false,
  });
}

/** Clear a session's captured env: new shells and agent restarts stop receiving it. */
export function useClearSessionEnv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      api<ClearSessionEnvResponse>('DELETE', `/api/sessions/${sessionId}/env`),
    onSuccess: (_res, sessionId) => {
      qc.setQueryData(['session-env', sessionId], { vars: [] } satisfies SessionEnvResponse);
    },
  });
}
