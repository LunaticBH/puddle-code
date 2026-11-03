import { runOpenNotebook } from '../editor/notebooks/notebook-run-registry';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import {
  UNTITLED_SESSION,
  type CompilationFileTarget,
  type CompilationFailure,
  type CompilationMode,
  type CompilationRunResponse,
  type CompilationSettingsRequest,
  type LatexSynctexResponse,
  type LayoutLeaf,
  type SavedLayout,
  type Session,
  type SessionKind,
  type TabRef,
} from '@puddle/shared';
import { createUntitled, deleteUntitled } from '../../lib/queries/untitled-queries';
import { deleteDraft, saveDraft } from '../../lib/persistence/drafts';
import { renameEntry } from '../../lib/queries/worktree-queries';
import { basename, dirOf, joinPath } from '../explorer/explorer-paths';
import { tabKind } from '../editor/tabs/editor-tabs';
import { previewKind } from '../editor/previews/preview-kind';
import { compilationSourceKey, sourceExtension } from '../editor/compilation/compilation-kind';
import { CompilationWatcher } from '../editor/compilation/CompilationWatcher';
import { CompilationSettingsDialog } from '../editor/compilation/CompilationSettingsDialog';
import { clearCompilationDiagnostics } from '../editor/compilation/compilation-diagnostics-store';
import { reportCompilationFailure } from '../editor/compilation/compilation-errors';
import { bumpMediaRefresh } from '../editor/previews/media-refresh-store';
import { saveCompilationInputs } from '../editor/buffers/save-registry';
import { requestActiveTabSave } from '../editor/buffers/active-tab-save';
import {
  forgetUntitledContent,
  setUntitledSaveHandler,
  type UntitledSaveRequest,
} from '../editor/buffers/untitled-save-store';
import { UntitledSaveDialog } from './tabs/UntitledSaveDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { useExplorerTarget } from '../explorer/use-explorer-target';
import { fileTabRevealTarget } from '../explorer/file-tab-reveal';
import {
  compilationSupported,
  compilationSettingsSupported,
  directoryTargetSupported,
  nativeConversationSyncSupported,
  untitledSupported,
} from '../../lib/transport/protocol-support';
import {
  setCompilationMode as setHostCompilationMode,
  useCompilationCapabilities,
  useRunCompilation,
} from '../../lib/queries/compilation-queries';
import {
  clientSettings,
  updateClientSettings,
  useClientSettings,
} from '../../lib/settings/client-settings';
import { useSessionTitleRenderer } from '../profile/use-session-title';
import {
  hostLabel,
  useAccounts,
  useAllSessions,
  useArchiveSession,
  useCreateSession,
  useDaemonVersion,
  useHostInfo,
  usePatchProfileSettings,
  useProfileSettings,
  useProjectDetail,
  useProjects,
  useRepos,
  refreshProjectConversations,
} from '../../lib/queries/queries';
import { mergeOrder, orderByDrag, reorderIds } from './sessions/session-order';
import { useNewSession } from '../shell/new-session-context';
import type { EditorTab } from '../editor/tabs/editor-tabs';
import {
  EditorProvider,
  useEditorHandler,
  type EditorPosition,
  type RevealTarget,
} from './editor-context';
import { toast } from 'sonner';
import { toastError } from '../../lib/transport/errors';
import { warmEditorChunk } from '../editor/lazy-editor-parts';
import { warmTerminalChunk } from '../terminal/LazyTerminal';
import { wsManager } from '../../lib/transport/ws';
import { registerHotkey, useHotkeyLabel } from '../../lib/navigation/hotkeys';
import { setScratchpadInsertHandler } from '../scratchpad/scratchpad-store';
import { setLayoutBridge } from '../layouts/layouts-store';
import {
  externalBrowseRoot,
  resolveFileLinkTarget,
  type FileLinkTarget,
} from '../terminal/links/file-links';
import { LocalPhonePane } from '../mobile/LocalPhonePane';
import { KeepAliveHost } from './keep-alive';
import { registerOpenPathHandler } from '../../lib/navigation/path-open';
import { requestReveal } from '../../lib/navigation/reveal-in-tree';
import { rememberClosedTab, takeClosedTab } from './tabs/closed-tabs';
import {
  allLeaves,
  boundToLiveSession,
  findLeaf,
  flattenTabs,
  pruneTabs,
  tabRefKey,
  type DropEdge,
} from './layout/layout-tree';
import {
  loadLayoutPatch,
  mergeShardedLayouts,
  parkedTerminalSessions,
  scopeUiState,
  splitToProjects,
  unionToProfile,
} from './layout/project-layout';
import { layoutSignature } from './layout/layout-signature';
import { projectAbbrev } from '../../lib/project-abbrev';
import { NARROW_VIEWPORT, useMediaQuery } from '../../lib/hooks/use-media-query';
import { layoutForPanels } from './layout/panel-layout';
import {
  CollapsedSidebarRail,
  NavigatorSidebar,
  normalizeSidebarMode,
  type SidebarMode,
} from './sidebar/NavigatorSidebar';
import { NewSessionDialog } from './sessions/NewSessionDialog';
import {
  CollapsedSessionsRail,
  SessionSidebar,
  type SessionGroup,
  type SidebarSessionSelection,
} from './sessions/SessionSidebar';
import { nextSessionSelection, retainVisibleSessions } from './sessions/session-selection';
import { TileTree } from './layout/TileTree';
import { TilingDnd } from './layout/TilingDnd';
import { useLayoutTree } from './layout/useLayoutTree';
import { useUiState } from './use-ui-state';
import { workspaceTitle } from './workspace-title';

/**
 * Project workspace (SPEC §8): the left navigator, the centre free-form tiling
 * area (editor + terminal tabs in `layout_tree`, driven by `useLayoutTree`), and
 * the right session sidebar. The tiling tree and the shell sizes persist PER
 * PROFILE — the shell sizes are one surface across the profile's projects — and
 * restore on open (SPEC §11); the project-based layout setting (ON by default
 * since 2026-08-04) narrows the TREE (not the shell) to per profile+project via
 * `scopeUiState`, so each project keeps its own panes. `EditorProvider` lets the explorer and
 * terminal links open files without prop-drilling; Monaco/xterm stay behind
 * lazy chunks (`KeepAliveHost` + the pane bodies).
 */
export function Workspace() {
  return (
    <EditorProvider>
      <WorkspaceInner />
    </EditorProvider>
  );
}

function WorkspaceInner() {
  const params = useParams();
  const navigate = useNavigate();
  const createSession = useCreateSession();
  const projectId = params['id'] ?? '';
  const validProject = /^[0-9a-f]{10}$/.test(projectId);
  const activeSessionId = params['sid'] ?? null;
  const location = useLocation();
  // A file tab can hide the URL's terminal without changing its session id.
  // Each notification click explicitly activates that terminal, even when the
  // URL is identical. Ordinary renders and file-tab switches keep their focus.
  const notificationKey =
    (location.state as { notificationSession?: unknown } | null)?.notificationSession ===
    activeSessionId
      ? location.key
      : null;
  // The detail query keeps the PREVIOUS project's data while the next one is in
  // flight, so a project switch never unmounts this component (open terminals
  // keep their viewport, and a sidebar double-click is not yanked out from under
  // the second click). `projectDetail` is therefore the id-checked handle —
  // undefined until THIS project's own detail has landed — and everything that
  // must be about this project reads it. The stale row is still good for the
  // PROFILE, which a within-profile switch does not change.
  const detail = useProjectDetail(validProject ? projectId : undefined);
  const projectDetail = detail.data?.project.id === projectId ? detail.data : undefined;
  const accounts = useAccounts(detail.data?.project.profile_id).data ?? [];
  const renderTitle = useSessionTitleRenderer();
  const saveKey = useHotkeyLabel('editor.save');
  const daemonProtocol = useDaemonVersion().data?.protocol;
  const qc = useQueryClient();
  const compilationCapabilities = useCompilationCapabilities(compilationSupported(daemonProtocol));
  const commandSettingsAvailable = compilationSettingsSupported(daemonProtocol);
  const runCompilation = useRunCompilation();
  const [compilationSettingsRequest, setCompilationSettingsRequest] =
    useState<CompilationSettingsRequest | null>(null);
  const [manualCompilationRunningKey, setManualCompilationRunningKey] = useState<string | null>(
    null,
  );
  const [eagerCompilationRunningKeys, setEagerCompilationRunningKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const compilationRunningKeys = useMemo(() => {
    const keys = new Set(eagerCompilationRunningKeys);
    if (manualCompilationRunningKey) keys.add(manualCompilationRunningKey);
    return keys;
  }, [eagerCompilationRunningKeys, manualCompilationRunningKey]);
  const availableCompilationProviders = useMemo(
    () => compilationCapabilities.data?.providers.filter((provider) => provider.available) ?? [],
    [compilationCapabilities.data],
  );
  const compilableExtensions = useMemo(
    () =>
      new Set(
        availableCompilationProviders.flatMap((provider) =>
          provider.extensions.map((extension) => extension.toLowerCase()),
        ),
      ),
    [availableCompilationProviders],
  );

  // Profile-keyed (SPEC §11): the layout tree is shared across projects, so the
  // tiling area needs every session it may hold a tab for — whatever the
  // project — for labels, status dots, and restore-time pruning.
  const baseUiState = useUiState();
  const allSessions = useAllSessions();
  // This project's sessions: its detail's list, or the all-sessions list
  // filtered — which is already in hand when the URL changes, so the navigators
  // never blink through an empty project while the detail is in flight.
  const sessions = useMemo(
    () =>
      projectDetail?.sessions ?? allSessions.data?.filter((s) => s.project_id === projectId) ?? [],
    [projectDetail, allSessions.data, projectId],
  );
  const tabSessions = allSessions.data ?? sessions;

  // Project-based layout (SPEC §11, client setting): the centre editor keeps a
  // layout per project instead of one profile-wide surface. Scoping waits for
  // the snapshot to say `layout_mode: 'project'` — the transition effect below
  // converts it — so a snapshot mid-transition is never read through the wrong
  // keys. Everything downstream uses the scoped handle; only the transition
  // and slice-prune effects reach for the base one.
  const clientSettingsNow = useClientSettings();
  const projectMode = clientSettingsNow.projectBasedLayout;
  // Independent of the layout mode since 2026-08-03 (they were one setting
  // through v0.0.24): this one only decides whether the right sidebar lists
  // every project's sessions or just this project's.
  const showAllSessions = clientSettingsNow.showAllProjectSessions;
  const projectScoped = projectMode && baseUiState.snapshot.layout_mode === 'project';
  const uiState = scopeUiState(baseUiState, projectId, projectScoped);
  const baseUiStateRef = useRef(baseUiState);
  baseUiStateRef.current = baseUiState;
  // Imperative reads for the saved-layout load path (layouts-store bridge).
  const allSessionsRef = useRef(allSessions.data);
  allSessionsRef.current = allSessions.data;

  // The right sidebar groups sessions by project (SPEC §12): every project's
  // sessions in the default profile-based layout (project order inherits the
  // homescreen's projectOrder, and the groups derive from the same
  // all-sessions list the tiling area uses), or just the current project's
  // under project-based layout — project names always stay as navigation
  // targets; drag reorders session_order in both.
  const profileId = detail.data?.project.profile_id;
  const profileProjects = useProjects(profileId);
  const profileSettings = useProfileSettings(profileId);
  const patchProfileSettings = usePatchProfileSettings(profileId ?? '');
  // THIS project's row: from its own detail once that lands, else from the
  // profile's project list — which already holds every project, so a switch
  // inside the profile knows the name, repo, and abbreviation at once and the
  // gate below never blanks for it. Only a cross-profile jump has neither.
  const project = projectDetail?.project ?? profileProjects.data?.find((p) => p.id === projectId);
  // The profile's live projects in sidebar order (the homescreen's
  // projectOrder) — the base for the session groups and for header drags.
  const orderedProjects = useMemo(() => {
    const projectRows = profileProjects.data ?? (project ? [project] : []);
    return orderByDrag(
      projectRows.filter((p) => !p.archived),
      profileSettings.data?.projectOrder ?? [],
    );
  }, [profileProjects.data, project, profileSettings.data]);
  const sessionGroups = useMemo<SessionGroup[]>(() => {
    const active = (s: Session) => s.status !== 'archived';
    const all = allSessions.data ?? sessions;
    return orderedProjects.map((p) => ({
      projectId: p.id,
      name: p.name,
      abbrev: projectAbbrev(p),
      colour: p.colour,
      repoId: p.repo_id,
      // Each group applies the same saved order the single-project view uses
      // (untracked sessions float to the top of their group, newest-first).
      sessions: orderByDrag(
        all.filter(
          (s) => s.project_id === p.id && active(s) && (showAllSessions || p.id === projectId),
        ),
        uiState.snapshot.session_order,
      ),
    }));
  }, [
    showAllSessions,
    sessions,
    projectId,
    uiState.snapshot.session_order,
    orderedProjects,
    allSessions.data,
  ]);
  // Sidebar selection is workspace state rather than list state so the same
  // selected conversations survive switching between the expanded list and
  // collapsed rail. The range follows their shared flattened visual order.
  const visibleSessionIds = useMemo(
    () => sessionGroups.flatMap((group) => group.sessions.map((session) => session.id)),
    [sessionGroups],
  );
  const [selectedSessionIds, setSelectedSessionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const sessionSelectionAnchor = useRef<string | null>(null);
  useEffect(() => {
    setSelectedSessionIds((selection) => retainVisibleSessions(selection, visibleSessionIds));
    if (
      sessionSelectionAnchor.current !== null &&
      !visibleSessionIds.includes(sessionSelectionAnchor.current)
    ) {
      sessionSelectionAnchor.current = null;
    }
  }, [visibleSessionIds]);
  const selectSidebarSession = useCallback(
    (id: string, modifiers: { shift: boolean; toggle: boolean }) => {
      setSelectedSessionIds((selection) => {
        const next = nextSessionSelection(
          visibleSessionIds,
          selection,
          sessionSelectionAnchor.current,
          id,
          modifiers,
        );
        sessionSelectionAnchor.current = next.anchor;
        return next.selection;
      });
    },
    [visibleSessionIds],
  );
  const selectOnlySidebarSession = useCallback((id: string) => {
    sessionSelectionAnchor.current = id;
    setSelectedSessionIds(new Set([id]));
  }, []);
  // A sidebar project-header drag persists into the SAME projectOrder the
  // homescreen cards drag (SPEC §11) — one source of truth for project order.
  // dragover fires continuously, so identical orders never re-persist.
  const moveProject = useCallback(
    (dragId: string, beforeId: string) => {
      const ids = orderedProjects.map((p) => p.id);
      const next = reorderIds(ids, dragId, beforeId);
      if (next.some((id, i) => id !== ids[i])) patchProfileSettings.mutate({ projectOrder: next });
    },
    [orderedProjects, patchProfileSettings],
  );
  // The archived disclosure, NEWEST CONVERSATION FIRST — by the very timestamp
  // its rows show (last activity, falling back to when it was created), so the
  // order you read is the order the list is in. Unlike the live groups it takes
  // no saved drag order: nothing is dragged in here, and "what was I last doing"
  // is the only question the list answers.
  //
  // A PROJECT-BASED layout never reaches past its own project (SPEC §12): the
  // whole point of that mode is that the window is about one project, and a
  // stranger's archived session offers nothing to do here. Profile-based layouts
  // keep the cross-project list, grouped in the sidebar's project order, when the
  // "all projects' sessions" client setting asks for it.
  const archivedSessions = useMemo(() => {
    const recency = (s: Session) => Date.parse(s.last_activity_at ?? s.created_at) || 0;
    const newestFirst = (rows: Session[]) => rows.sort((a, b) => recency(b) - recency(a));
    const archived = (s: Session) => s.status === 'archived';
    if (projectScoped || !showAllSessions) return newestFirst(sessions.filter(archived));
    const all = allSessions.data ?? sessions;
    return orderedProjects.flatMap((p) =>
      newestFirst(all.filter((s) => s.project_id === p.id && archived(s))),
    );
  }, [showAllSessions, projectScoped, sessions, allSessions.data, orderedProjects]);

  // One-shot layout-mode transitions (SPEC §11): when the client's
  // project-based layout setting disagrees with the mode the snapshot was last
  // maintained in, convert it — split the shared tree into per-project slices
  // on the way in, union the slices back on the way out — and stamp
  // `layout_mode`, so a snapshot converts exactly once even when the setting
  // flipped while no workspace was open (or in another browser).
  const orderedProjectsRef = useRef(orderedProjects);
  orderedProjectsRef.current = orderedProjects;
  const profileProjectsRef = useRef(profileProjects.data);
  profileProjectsRef.current = profileProjects.data;
  useEffect(() => {
    const base = baseUiStateRef.current;
    if (!base.loaded) return;
    const snap = base.current();
    const mode = snap.layout_mode ?? 'profile';
    if (projectMode && mode !== 'project') {
      // The split needs the session → project map and the full project list
      // (archived projects included — their sessions' tabs must land
      // somewhere); wait until both have arrived.
      if (!allSessions.data || !profileProjects.data) return;
      const sessionProject = new Map(allSessions.data.map((s) => [s.id, s.project_id]));
      const patch = splitToProjects(
        snap,
        profileProjects.data.map((p) => p.id),
        sessionProject,
        projectId,
      );
      base.update({
        ...patch,
        // Slices preserved through an earlier profile-layout load beat their
        // shard: flipping the setting must never erase stored per-project
        // layouts (SPEC §11).
        project_layouts: mergeShardedLayouts(patch.project_layouts ?? {}, snap.project_layouts),
      });
    } else if (!projectMode && mode === 'project') {
      // Union order: the current project's slice leads, the rest follow the
      // sidebar's project order.
      base.update(
        unionToProfile(snap, [projectId, ...orderedProjectsRef.current.map((p) => p.id)]),
      );
    }
  }, [projectMode, baseUiState.loaded, allSessions.data, profileProjects.data, projectId]);

  // WHICH tree is live: the profile-wide surface, or this project's slice. It
  // keys the layout controller's migration cache and the closed-tab stack alike
  // — a reopen must land in the tree the tab was closed from.
  const scopeKey = projectScoped ? `project:${projectId}` : 'profile';
  const layout = useLayoutTree(uiState, scopeKey);
  // Locked-preview scrolling owns a separate transient focus from the pane
  // focus that routes opens, tab hotkeys, sidebar binding, and saves. A wheel
  // gesture may move this owner without making the scrolled pane the next-open
  // destination (decision 2026-08-13).
  const [scrollDriverOwner, setScrollDriverOwner] = useState<{
    scopeKey: string;
    leafId: string;
  } | null>(null);
  const claimScrollDriver = useCallback(
    (leafId: string) => setScrollDriverOwner({ scopeKey, leafId }),
    [scopeKey],
  );
  const ownedScrollLeaf =
    scrollDriverOwner?.scopeKey === scopeKey
      ? findLeaf(layout.tree, scrollDriverOwner.leafId)
      : null;
  const scrollDriverLeafId = ownedScrollLeaf?.id ?? layout.focusedLeaf.id;
  // A real logical activation starts a fresh scroll-driving context. The deps
  // stay unchanged when only `scrollDriverOwner` moves, so wheel input does not
  // immediately snap ownership back to the logically focused pane.
  useEffect(() => {
    claimScrollDriver(layout.focusedLeaf.id);
  }, [claimScrollDriver, layout.focusedLeaf.id, layout.focusedLeaf.activeKey]);
  const focusLeaf = useCallback(
    (leafId: string) => {
      layout.focusLeaf(leafId);
      claimScrollDriver(leafId);
    },
    [layout, claimScrollDriver],
  );
  // The terminals the OTHER projects' layouts hold open. Only under
  // project-based layout: the profile-wide tree already contains every tab, so
  // there is nothing outside it to keep alive (and a preserved slice's tabs are
  // not open in that mode). Keeping them mounted is what makes a project switch
  // park terminals rather than rebuild them (SPEC §11).
  const projectSlices = baseUiState.snapshot.project_layouts;
  const parkedSessions = useMemo(
    () => (projectScoped ? parkedTerminalSessions(projectSlices, projectId) : []),
    [projectScoped, projectSlices, projectId],
  );
  // Effects reference the controller through a ref so they don't list `layout`
  // (which changes on every tree edit) as a dependency — otherwise a
  // focus/ensure op would re-trigger the effect that made it, looping.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const compilationProviderForTab = useCallback(
    (tab: EditorTab) => {
      const extension = sourceExtension(tab.path);
      return extension === null
        ? undefined
        : availableCompilationProviders.find((provider) => provider.extensions.includes(extension));
    },
    [availableCompilationProviders],
  );
  const providerForTab = useCallback(
    (tab: EditorTab) => compilationProviderForTab(tab)?.id,
    [compilationProviderForTab],
  );
  const compilationScope = useCallback(
    (sessionId: string) => {
      if (profileId === undefined) return null;
      return {
        profile_id: profileId,
        project_id:
          tabSessions.find((session) => session.id === sessionId)?.project_id ?? projectId,
      };
    },
    [profileId, projectId, tabSessions],
  );
  const compilationTarget = useCallback(
    (tab: EditorTab) => {
      const provider = providerForTab(tab);
      const scope = compilationScope(tab.session);
      return {
        source: {
          session: tab.session,
          path: tab.path,
          ...(tab.root !== undefined ? { root: tab.root } : {}),
        } satisfies CompilationFileTarget,
        ...(provider !== undefined ? { provider } : {}),
        ...(scope ?? {}),
      };
    },
    [compilationScope, providerForTab],
  );
  const openCompilationSettings = useCallback(
    (source: CompilationFileTarget) => {
      if (!commandSettingsAvailable || profileId === undefined) return;
      const extension = sourceExtension(source.path);
      const provider =
        extension === null
          ? undefined
          : availableCompilationProviders.find((candidate) =>
              candidate.extensions.includes(extension),
            );
      const scope = compilationScope(source.session);
      if (!provider || !scope) return;
      setCompilationSettingsRequest({ source, provider: provider.id, ...scope });
    },
    [availableCompilationProviders, commandSettingsAvailable, compilationScope, profileId],
  );

  const presentCompilationResult = useCallback(
    (leafId: string, result: CompilationRunResponse, activate: boolean) => {
      const preview = result.artifacts.find((artifact) => artifact.role === 'preview');
      if (!preview) return;
      bumpMediaRefresh(preview.file.session, preview.file.path, preview.file.root);
      void qc.invalidateQueries({
        queryKey:
          preview.file.root === undefined
            ? ['wt-file', preview.file.session, preview.file.path]
            : ['wt-file', preview.file.session, preview.file.path, preview.file.root],
        exact: true,
      });
      layoutRef.current.openEditorInLeaf(
        leafId,
        {
          session: preview.file.session,
          path: preview.file.path,
          ...(preview.file.root !== undefined
            ? { kind: 'external' as const, root: preview.file.root }
            : { kind: 'file' as const }),
          generated_by: result.provider,
          ...(previewKind(preview.file.path) ? { view: 'preview' as const } : {}),
        },
        { dedupeAcrossTree: true, activate },
      );
    },
    [qc],
  );

  const onRunCompilation = useCallback(
    async (leafId: string, tab: EditorTab, executedCopy = false) => {
      if (
        !executedCopy &&
        tab.path.toLowerCase().endsWith('.ipynb') &&
        runOpenNotebook({
          session: tab.session,
          path: tab.path,
          ...(tab.root ? { root: tab.root } : {}),
        })
      )
        return;
      if (manualCompilationRunningKey !== null) return;
      const target = compilationTarget(tab);
      const provider = compilationProviderForTab(tab);
      if (!provider) return;
      const sourceKey = compilationSourceKey(tab.session, tab.path, tab.root);
      setManualCompilationRunningKey(sourceKey);
      try {
        const saved = await saveCompilationInputs(
          target.source,
          new Set(provider.input_extensions),
        );
        if (!saved) {
          toast.error('Run cancelled because an input could not be saved');
          return;
        }
        if ((tab.compile_mode ?? 'on_demand') === 'eager') {
          layoutRef.current.setCompileMode(tab, 'on_demand');
          await setHostCompilationMode({ ...target, mode: 'on_demand' });
        }
        const result = await runCompilation.mutateAsync(target);
        clearCompilationDiagnostics(
          compilationSourceKey(result.source.session, result.source.path, result.source.root),
        );
        if (result.terminal) {
          await qc.invalidateQueries({ queryKey: ['sessions'] });
          void qc.invalidateQueries({ queryKey: ['project', result.terminal.project_id] });
          layoutRef.current.ensureTerminal(result.terminal.id);
          void navigate(`/project/${result.terminal.project_id}/session/${result.terminal.id}`);
          return;
        }
        presentCompilationResult(leafId, result, true);
        toast.success(
          `${provider.action === 'run' ? 'Ran' : 'Compiled'} ${basename(result.source.path)}`,
        );
      } catch (error) {
        reportCompilationFailure(sourceKey, error);
      } finally {
        setManualCompilationRunningKey(null);
      }
    },
    [
      manualCompilationRunningKey,
      compilationProviderForTab,
      compilationTarget,
      presentCompilationResult,
      runCompilation,
      qc,
      navigate,
    ],
  );

  const onSetCompilationMode = useCallback(
    async (tab: EditorTab, mode: CompilationMode) => {
      const previous = tab.compile_mode ?? 'on_demand';
      if (previous === mode) return;
      const provider = compilationProviderForTab(tab);
      if (!provider || (mode === 'eager' && !provider.eager)) return;
      const target = compilationTarget(tab);
      if (
        mode === 'eager' &&
        !(await saveCompilationInputs(target.source, new Set(provider.input_extensions)))
      ) {
        toast.error('Eager compilation was not enabled because an input could not be saved');
        return;
      }
      layoutRef.current.setCompileMode(tab, mode);
      // Mounting CompilationWatcher registers eager mode and delivers its
      // initial build. On-demand has no watcher, so retire it explicitly.
      if (mode === 'on_demand') {
        void setHostCompilationMode({ ...target, mode }).catch((error: unknown) => {
          layoutRef.current.setCompileMode(tab, previous);
          toastError(error);
        });
      }
    },
    [compilationProviderForTab, compilationTarget],
  );

  const eagerCompilationTargets = useMemo(() => {
    const targets = new Map<
      string,
      { leafId: string; target: ReturnType<typeof compilationTarget> }
    >();
    for (const leaf of allLeaves(layout.tree)) {
      for (const ref of leaf.tabs) {
        if (ref.type !== 'editor' || ref.tab.compile_mode !== 'eager') continue;
        const provider = providerForTab(ref.tab);
        if (!provider || !compilationProviderForTab(ref.tab)?.eager) continue;
        const key = compilationSourceKey(ref.tab.session, ref.tab.path, ref.tab.root);
        if (!targets.has(key)) {
          targets.set(key, { leafId: leaf.id, target: compilationTarget(ref.tab) });
        }
      }
    }
    return [...targets.entries()].map(([key, value]) => ({ key, ...value }));
  }, [layout.tree, compilationTarget, providerForTab, compilationProviderForTab]);

  const onEagerCompilationResult = useCallback(
    (_sourceKey: string, leafId: string, result: CompilationRunResponse) => {
      clearCompilationDiagnostics(
        compilationSourceKey(result.source.session, result.source.path, result.source.root),
      );
      presentCompilationResult(leafId, result, false);
    },
    [presentCompilationResult],
  );
  const onEagerCompilationError = useCallback(
    (sourceKey: string, failure: CompilationFailure) =>
      reportCompilationFailure(sourceKey, failure),
    [],
  );
  const setEagerCompilationRunning = useCallback((key: string, running: boolean) => {
    setEagerCompilationRunningKeys((current) => {
      const has = current.has(key);
      if (has === running) return current;
      const next = new Set(current);
      if (running) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  // `useUiState` returns a fresh handle object every render, so effects must
  // reach it through a ref — listing `uiState` in a dependency array would fire
  // the effect on EVERY render, not only when its real inputs change.
  const uiStateRef = useRef(uiState);
  uiStateRef.current = uiState;
  // Reorder-persist, shared by the expanded sidebar and the collapsed rail:
  // merge so a single-project reorder never forgets hidden projects' sessions.
  const persistReorder = useCallback(
    (ids: string[]) =>
      uiStateRef.current.update({
        session_order: mergeOrder(ids, uiStateRef.current.snapshot.session_order),
      }),
    [],
  );
  // Narrow (phone) layout, SPEC §12: the sidebars leave the panel row and
  // open as overlays from their rails. Overlay visibility is LOCAL state, not
  // ui_state — the persisted collapse flags belong to the desktop layout, and
  // a phone visit must not clobber them (ui_state is shared per profile).
  const isNarrow = useMediaQuery(NARROW_VIEWPORT);
  const [phoneSelection, setPhoneSelection] = useState<string | null>(null);
  const [phoneVisited, setPhoneVisited] = useState<string[]>([]);
  const isNarrowRef = useRef(isNarrow);
  isNarrowRef.current = isNarrow;
  const [narrowNav, setNarrowNav] = useState(false);
  const [narrowSessions, setNarrowSessions] = useState(false);
  // Restore-on-open runs once per project VISIT, not per mount: switching
  // projects in the sidebar re-runs it against the new project's stored
  // active session (which per-project layouts make a distinct value).
  const [restoredProject, setRestoredProject] = useState<string | null>(null);
  const restored = restoredProject === projectId;
  const [creating, setCreating] = useState(false);
  const [createKind, setCreateKind] = useState<SessionKind>('agent');
  const [seedAccountId, setSeedAccountId] = useState<number | undefined>(undefined);
  // Where the create dialogue lands its session: null = the current project;
  // a project-header context menu retargets it (SPEC §12) via `openCreateIn`.
  const [createTarget, setCreateTarget] = useState<{ projectId: string; repoId: number } | null>(
    null,
  );
  const openCreate = useCallback(
    (kind: SessionKind = 'agent', target?: { projectId: string; repoId: number }) => {
      setSeedAccountId(undefined);
      setCreateTarget(target ?? null);
      setCreateKind(kind);
      setCreating(true);
    },
    [],
  );
  // "New agent/terminal in this project" from a project header's right-click:
  // the SAME create dialogue, seeded with that project instead of the current.
  const openCreateIn = useCallback(
    (kind: SessionKind, pid: string) => {
      const p = orderedProjects.find((x) => x.id === pid);
      openCreate(kind, p ? { projectId: p.id, repoId: p.repo_id } : undefined);
    },
    [orderedProjects, openCreate],
  );
  // Set when the active tab is closed: the router clears the URL param a
  // render later, so this stops the deep-link effect resurrecting the tab in
  // the interim (it would otherwise leave a zombie header — no active session).
  const justClosedActive = useRef<string | null>(null);
  // A session opened from ANOTHER project's group in the sidebar (SPEC §11):
  // under project-based layouts that project keeps its own tree, so the tab
  // cannot be opened here — the gesture navigates instead, and the navigation
  // effect opens it once THAT project's layout is the live one. `pin` carries
  // whether the gesture meant permanent (a drop, a double-click) or preview (a
  // single click). This survives the switch because the query keeps the previous
  // detail, so the workspace re-renders rather than remounting.
  const pendingOpen = useRef<{ session: string; pin: boolean } | null>(null);
  const { setHandler } = useNewSession();

  // A cockpit transition schedules one coalesced native-store refresh. The
  // project renders from its normal cache while discovery runs in the daemon;
  // `sessions-changed` invalidates the catalogue only when rows actually move.
  useEffect(() => {
    if (!validProject || !nativeConversationSyncSupported(daemonProtocol)) return;
    void refreshProjectConversations(projectId).catch(() => undefined);
  }, [daemonProtocol, projectId, validProject]);

  // Follow an exact native switch only in the viewer that was focused on the
  // source session. The source tab stays in the tree as frozen history; the
  // target opens as a preview in the focused pane (or the destination
  // project's focused pane after navigation).
  useEffect(
    () =>
      wsManager.onSessionSwitched((event) => {
        if (event.source_session !== activeSessionId) return;
        pendingOpen.current = { session: event.target_session, pin: false };
        if (event.target_project === projectId) {
          layoutRef.current.ensureTerminal(event.target_session, { preview: true });
        }
        void navigate(`/project/${event.target_project}/session/${event.target_session}`);
      }),
    [activeSessionId, navigate, projectId],
  );

  // Opening any tab from a navigator (files tree, diff list, history list) or a
  // Phase 4 terminal link adds/focuses its editor tab and makes it active —
  // pure ui-state, so it works before the lazy editor chunk loads. A `position`
  // arrives with a fresh nonce so the editor zone reveals the caret even when
  // the same file tab was already open (only meaningful for file tabs).
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  const revealCompiledSource = useCallback(
    (leafId: string, target: LatexSynctexResponse) => {
      const sourceLeafId = layoutRef.current.openEditorInLeaf(
        leafId,
        {
          session: target.session,
          path: target.path,
          ...(target.root !== undefined
            ? { kind: 'external' as const, root: target.root }
            : { kind: 'file' as const }),
        },
        { dedupeAcrossTree: true },
      );
      claimScrollDriver(sourceLeafId);
      setReveal({
        session: target.session,
        path: target.path,
        ...(target.root !== undefined ? { root: target.root } : {}),
        line: target.line,
        column: target.column,
        nonce: Date.now(),
      });
    },
    [claimScrollDriver],
  );
  const openEditorTab = useCallback(
    (tab: EditorTab, position?: EditorPosition, opts?: { preview?: boolean }) => {
      claimScrollDriver(layout.focusedLeaf.id);
      layout.openEditor(tab, { preview: opts?.preview });
      // On a phone the navigator overlay covers the pane it just opened into.
      if (isNarrowRef.current) setNarrowNav(false);
      if (position && ['file', 'external'].includes(tab.kind ?? 'file')) {
        setReveal({
          session: tab.session,
          path: tab.path,
          ...(tab.root !== undefined ? { root: tab.root } : {}),
          line: position.line,
          column: position.column,
          nonce: Date.now(),
        });
      }
    },
    [layout, claimScrollDriver],
  );
  // Stable file-open handler for terminal links, the explorer, and the editor
  // context (keeps the original `(session, path, position?)` shape). Opens are
  // permanent by default; the explorer opts into preview per single-vs-double
  // click (VSCode-style).
  const openFile = useCallback(
    (
      sessionId: string,
      path: string,
      position?: EditorPosition,
      opts?: { preview?: boolean; view?: 'source' | 'preview'; root?: string },
    ) =>
      openEditorTab(
        {
          // A rooted open is an `external` tab: the path is relative to the
          // browse root, and a `file` tab would resolve it against the
          // WORKTREE (see OpenFileOpts.root).
          ...(opts?.root !== undefined
            ? { kind: 'external' as const, session: sessionId, path, root: opts.root }
            : { kind: 'file' as const, session: sessionId, path }),
          ...(opts?.view
            ? { view: opts.view }
            : !position && previewKind(path) === 'notebook'
              ? { view: 'preview' as const }
              : {}),
        },
        position,
        opts,
      ),
    [openEditorTab],
  );
  useEditorHandler(openFile);
  const revealPreviewSource = useCallback(
    (leafId: string, tab: EditorTab, position: EditorPosition) => {
      const sourceLeafId = layout.revealSource(leafId, tab);
      claimScrollDriver(sourceLeafId);
      setReveal({
        session: tab.session,
        path: tab.path,
        ...(tab.root !== undefined ? { root: tab.root } : {}),
        line: position.line,
        column: position.column,
        nonce: Date.now(),
      });
    },
    [layout, claimScrollDriver],
  );
  // A validated terminal link (SPEC §7): a file opens an editor tab — an
  // `external` one when it lies outside the worktree (15.2) — and a DIRECTORY
  // binds the file tree to it as a pinned browse (SPEC §8), surfacing the
  // Files navigator first so the result is actually visible.
  const [browseRequest, setBrowseRequest] = useState<{
    session: string;
    root: string;
    nonce: number;
  } | null>(null);
  const filetreeRootRef = useRef<string | null>(null);
  const rememberFiletreeRoot = useCallback((root: string | null) => {
    filetreeRootRef.current = root;
  }, []);
  // Explorer clicks: a single click opens an ephemeral preview tab; a double
  // click opens (or promotes to) a permanent one.
  const openTreeFile = useCallback(
    (sessionId: string, path: string, opts?: { preview?: boolean }) =>
      openFile(sessionId, path, undefined, { preview: opts?.preview ?? true }),
    [openFile],
  );
  // "Open terminal in directory" from the file tree's context menu: a terminal
  // session joining the SAME worktree, whose shell simply starts in the folder
  // that was right-clicked (SPEC §8). It belongs to the worktree like any other
  // terminal — only the initial cwd differs.
  const openTerminalIn = useCallback(
    (sessionId: string, dir: string) => {
      const owner = sessions.find((s) => s.id === sessionId);
      if (!owner) return;
      createSession.mutate(
        {
          project_id: owner.project_id,
          kind: 'terminal',
          separate_branch: false,
          separate_worktree: false,
          join_worktree: owner.worktree_path,
          cwd: dir,
        },
        {
          onSuccess: (t) => void navigate(`/project/${t.project_id}/session/${t.id}`),
          onError: (e) => toastError(e),
        },
      );
    },
    [sessions, createSession, navigate],
  );
  const promoteTab = useCallback((ref: TabRef) => layout.promote(ref), [layout]);
  // Files opened from the explorer's parent-directory browse: a read-only
  // `external` tab carrying its browse root (SPEC §8). Preview by default,
  // like tree clicks.
  const openExternalFile = useCallback(
    (sessionId: string, path: string, root: string, opts?: { preview?: boolean }) =>
      openEditorTab({ kind: 'external', session: sessionId, path, root }, undefined, {
        preview: opts?.preview ?? true,
      }),
    [openEditorTab],
  );

  // Double-click on a strip's blank tail: a fresh untitled draft (SPEC §8) —
  // worktree-AGNOSTIC, held in the profile's untitled store until ⌘S places
  // it into the bound worktree via the save-as dialogue below. The nil-uuid
  // `session` keeps the tab schema-valid while binding to nothing.
  // Feature-detect the untitled store (PROTOCOL.md rule 3): on a pre-10.3
  // daemon the POST would 404, which reads as a bug rather than a version
  // gap — say what is actually missing. Unknown (still fetching) reads as
  // supported, like every other gate.
  const draftsSupported = untitledSupported(daemonProtocol);
  const onNewUntitled = useCallback(
    (_leaf: LayoutLeaf) => {
      if (profileId === undefined) return;
      if (!draftsSupported) {
        toast.error('Untitled drafts need a newer daemon — refresh the connection to update it');
        return;
      }
      createUntitled(profileId)
        .then(({ name }) =>
          openEditorTab({ kind: 'untitled', session: UNTITLED_SESSION, path: name }),
        )
        .catch((e: unknown) =>
          toast.error(e instanceof Error ? e.message : 'Could not create a draft'),
        );
    },
    [openEditorTab, profileId, draftsSupported],
  );

  // Save-as for untitled drafts: pick a path in the BOUND worktree, write it
  // there, drop the draft, and swap the tab for an ordinary file tab.
  const [savingUntitled, setSavingUntitled] = useState<UntitledSaveRequest | null>(null);
  useEffect(() => {
    setUntitledSaveHandler(setSavingUntitled);
    return () => setUntitledSaveHandler(null);
  }, []);

  // Closing an untitled tab discards its draft — confirmed first, since the
  // draft file is deleted with it (nothing lists orphaned drafts).
  const [discardingUntitled, setDiscardingUntitled] = useState<{
    leafId: string;
    ref: TabRef;
  } | null>(null);
  const confirmDiscardUntitled = () => {
    const d = discardingUntitled;
    setDiscardingUntitled(null);
    if (!d || d.ref.type !== 'editor') return;
    const name = d.ref.tab.path;
    if (profileId !== undefined) void deleteUntitled(profileId, name).catch(() => undefined);
    forgetUntitledContent(name);
    layout.close(d.leafId, d.ref);
  };

  // A saved draft: drop its untitled tab (wherever it sits) and open the real
  // file tab in its place. Two layout ops, deliberately split across a tick —
  // each op persists against the tree its render saw, so the second must run
  // after the first has committed.
  const finishUntitledSave = (name: string, sessionId: string, path: string, root?: string) => {
    setSavingUntitled(null);
    const ref: TabRef = {
      type: 'editor',
      tab: { kind: 'untitled', session: UNTITLED_SESSION, path: name },
    };
    const key = tabRefKey(ref);
    for (const leaf of allLeaves(layoutRef.current.tree)) {
      if (leaf.tabs.some((t) => tabRefKey(t) === key)) layoutRef.current.close(leaf.id, ref);
    }
    void qc.invalidateQueries({ queryKey: ['wt-tree', sessionId] });
    setTimeout(() => {
      // A draft saved into a directory target becomes an `external` tab: that is
      // the kind whose identity and requests carry a root (SPEC §8).
      layoutRef.current.openEditor(
        root === undefined
          ? { kind: 'file', session: sessionId, path }
          : { kind: 'external', session: sessionId, path, root },
      );
    }, 0);
  };

  // The ⌘K palette, top bar, and profile panel reuse this modal; an account
  // id seeds the picker (profile panel → session on a chosen account).
  useEffect(() => {
    setHandler((opts) => {
      setSeedAccountId(opts?.accountId);
      setCreateKind(opts?.kind ?? 'agent');
      setCreating(true);
    });
    return () => setHandler(null);
  }, [setHandler]);

  // Reload must not suspend mid-restore: mounting the restored tree while the
  // Monaco/xterm chunks are still cold suspended EVERY pane into its fallback
  // ("Loading editor…" / a blank terminal) — and the reveal only reached the
  // screen on the next render (a tab click). Warm exactly the chunks the
  // restored tabs need behind the existing loading gate; once warm, the lazy
  // wrappers render their components directly, with no Suspense pass at all.
  // A terminal-only workspace still loads no Monaco (SPEC §8); an empty one
  // warms nothing. `.finally`: a failed import degrades to the old lazy path
  // rather than wedging the workspace. This gates the FIRST open only — a later
  // project switch keeps the workspace mounted (and its warmed chunks), and
  // must not re-blank it to wait on a chunk the new tree may not even need. It
  // still re-runs per scope, so the tree a switch brings up warms what it needs
  // as early as possible — just without holding the render back.
  const [chunksReady, setChunksReady] = useState(false);
  useEffect(() => {
    if (!uiState.loaded) return;
    const tabs = flattenTabs(layoutRef.current.tree);
    void Promise.all([
      tabs.some((t) => t.type === 'terminal') ? warmTerminalChunk() : undefined,
      tabs.some((t) => t.type === 'editor') ? warmEditorChunk() : undefined,
    ]).finally(() => setChunksReady(true));
  }, [uiState.loaded, scopeKey]);

  // Restore-on-open: land on the stored active session unless the URL already
  // deep-links one. Navigation only follows a stored session of THIS project
  // (the project detail's own list decides — entering project A must not yank
  // the URL to wherever the profile last worked), so restore never waits on
  // anything beyond the detail fetch and terminals open immediately.
  // It waits for THIS project's detail (`projectDetail`), never the stale row a
  // switch renders through: the stored session is looked up in that list.
  useEffect(() => {
    if (restored || !uiState.loaded || !projectDetail) return;
    setRestoredProject(projectId);
    const stored = uiState.snapshot.active_session;
    const storedSession = sessions.find((s) => s.id === stored);
    if (!activeSessionId && storedSession && storedSession.status !== 'archived') {
      void navigate(`/project/${projectId}/session/${storedSession.id}`, { replace: true });
    }
  }, [restored, uiState, projectDetail, sessions, activeSessionId, navigate, projectId]);

  // Prune dead tabs (and dead session_order ids) once per mount, whenever the
  // FULL session list first arrives — decoupled from `restored` so a slow or
  // transiently failing fetch neither blocks the workspace nor forfeits the
  // prune for the window's lifetime. The alive set must span EVERY session on
  // the daemon: the profile-keyed tree holds cross-project tabs, and pruning
  // against one project's list would wipe the rest.
  const pruned = useRef(false);
  useEffect(() => {
    if (pruned.current || !uiState.loaded || !allSessions.data) return;
    pruned.current = true;
    const alive = new Set(allSessions.data.filter((s) => s.status !== 'archived').map((s) => s.id));
    layoutRef.current.pruneSessions(alive);
    // Project-based slices hold trees the visible prune above never touches
    // (it sees only the scoped tree) — prune every stored slice the same way.
    // Read through current(): the visible prune has already written this tick.
    const base = baseUiStateRef.current;
    const record = base.current().project_layouts;
    if (Object.keys(record).length > 0) {
      const keep = boundToLiveSession(alive);
      base.update({
        project_layouts: Object.fromEntries(
          Object.entries(record).map(([pid, slice]) => [
            pid,
            {
              ...slice,
              layout_tree: slice.layout_tree ? pruneTabs(slice.layout_tree, keep) : null,
              active_session:
                slice.active_session !== null && alive.has(slice.active_session)
                  ? slice.active_session
                  : null,
            },
          ]),
        ),
      });
    }
    const order = uiStateRef.current.snapshot.session_order;
    const liveOrder = order.filter((id) => alive.has(id));
    if (liveOrder.length !== order.length) {
      uiStateRef.current.update({ session_order: liveOrder });
    }
  }, [uiState.loaded, allSessions.data]);

  // A session navigation or explicit notification click ensures a terminal for
  // that session and focuses it — added to the currently focused pane if absent,
  // else just focused — and records it as the stored active session (for reload
  // restore + the left-sidebar bind). This must fire ONCE per navigation, not on
  // every render: re-running it would re-assert the session's terminal as its
  // leaf's active tab, so clicking a file tab that shares the pane would flip
  // straight back to the terminal. Hence the ref-based `uiState`/`layout` access
  // and the deps limited to what actually changes on navigation.
  useEffect(() => {
    if (!restored) return;
    if (isNarrowRef.current) {
      if (activeSessionId) {
        setPhoneSelection(activeSessionId);
        setPhoneVisited((ids) => (ids.includes(activeSessionId) ? ids : [...ids, activeSessionId]));
      }
      setNarrowSessions(false);
      return;
    }
    // Navigation is how a phone picks a session — the overlay's job is done.
    setNarrowSessions(false);
    if (!activeSessionId) {
      justClosedActive.current = null; // close completed; the URL caught up
      return;
    }
    // Don't re-open the tab we're closing while the URL param still lags.
    if (activeSessionId === justClosedActive.current && !notificationKey) return;
    justClosedActive.current = null;
    // A gesture that had to cross projects to reach its layout (see
    // `pendingOpen`) says how the tab lands; any other navigation is a plain
    // single click. One navigation consumes the intent whether it matched or not,
    // so a stale one cannot pin a later open.
    const intent = pendingOpen.current;
    pendingOpen.current = null;
    // Single-click navigation opens the session as an ephemeral preview tab
    // (VSCode-style); double-clicking its tab promotes it to permanent.
    layoutRef.current.ensureTerminal(activeSessionId, {
      preview: intent?.session === activeSessionId ? !intent.pin : true,
    });
    const ui = uiStateRef.current;
    if (ui.snapshot.active_session !== activeSessionId) {
      ui.update({ active_session: activeSessionId });
    }
  }, [restored, activeSessionId, notificationKey]);

  // waiting_input is mirrored in the tab title (SPEC §12). The title's base
  // is the machine's label (display-name customisation first, then hostname),
  // not the app name — the window says which host and project it drives.
  const host = useHostInfo();
  useEffect(() => {
    const base = hostLabel(host.data) ?? 'Puddle';
    const waiting = sessions.filter((s) => s.status === 'waiting_input').length;
    const name = project?.name ?? 'Puddle';
    document.title = workspaceTitle(name, base, waiting);
    return () => {
      document.title = base;
    };
  }, [sessions, project?.name, host.data]);

  // Closing a session from the sidebar / its lifecycle menu removes its terminal
  // from the tree; if it was the URL-bound one, drop the binding.
  const closeTab = useCallback(
    (id: string) => {
      const wasActive = activeSessionId === id;
      if (wasActive) justClosedActive.current = id;
      layout.removeTerminal(id);
      if (wasActive) {
        uiState.update({ active_session: null });
        void navigate(`/project/${projectId}`);
      }
    },
    [layout, uiState, activeSessionId, navigate, projectId],
  );
  // Sessions dropped on an archive target (rail icon / list header), or chosen
  // through a selected row's batch menu: archive every one — no confirmation,
  // nothing is destroyed (SPEC §4) — and drop their tabs.
  // Declared HERE, with the other hooks: every hook in this component must run
  // before the loading gate below returns early, or the gate flipping changes
  // the hook count mid-life and React blanks the workspace (React #310).
  const archiveSession = useArchiveSession();
  const archiveSidebarSessions = useCallback(
    async (ids: readonly string[]) => {
      const uniqueIds = [...new Set(ids)];
      const results = await Promise.allSettled(
        uniqueIds.map((id) => archiveSession.mutateAsync(id)),
      );
      const archivedIds = uniqueIds.filter((_, index) => results[index]?.status === 'fulfilled');
      for (const id of archivedIds) closeTab(id);
      if (archivedIds.length > 0) {
        setSelectedSessionIds((selection) => {
          const next = new Set(selection);
          for (const id of archivedIds) next.delete(id);
          return next;
        });
        if (
          sessionSelectionAnchor.current !== null &&
          archivedIds.includes(sessionSelectionAnchor.current)
        ) {
          sessionSelectionAnchor.current = null;
        }
      }
      const failures = results.filter((result) => result.status === 'rejected');
      const firstFailure = failures[0];
      if (failures.length === 1 && firstFailure) {
        toastError(firstFailure.reason);
      } else if (failures.length > 1) {
        toast.error(`Couldn’t archive ${failures.length} of ${uniqueIds.length} sessions`);
      }
    },
    [archiveSession, closeTab],
  );
  const sidebarSessionSelection: SidebarSessionSelection = {
    ids: selectedSessionIds,
    onSelect: selectSidebarSession,
    onSelectOnly: selectOnlySidebarSession,
    onArchive: (ids) => void archiveSidebarSessions(ids),
  };

  // Activating a tab focuses its pane; activating a terminal also navigates so
  // the left sidebar binds to it. A terminal tab may belong to ANOTHER project
  // (the cross-project sidebar can open one here), so navigate to the session's
  // OWN project — otherwise the URL keeps this project and the file tree, bound
  // to a session it doesn't own, shows empty. Closing a pane tab mirrors `closeTab`.
  const onActivateTab = useCallback(
    (leafId: string, ref: TabRef) => {
      claimScrollDriver(leafId);
      layout.activate(leafId, ref);
      if (ref.type === 'terminal' && ref.session !== activeSessionId) {
        // Navigate only when the owner is KNOWN: guessing the current project
        // while the all-sessions list is still loading would bind another
        // project's session under the wrong URL (empty header + file tree).
        // The tab itself activates regardless; the URL catches up on the next
        // click once the list has landed. Already-bound sessions skip the
        // navigate — pane-body clicks would otherwise pile up history entries.
        const owner = tabSessions.find((s) => s.id === ref.session)?.project_id;
        if (owner) void navigate(`/project/${owner}/session/${ref.session}`);
      }
    },
    [layout, navigate, tabSessions, activeSessionId, claimScrollDriver],
  );
  const onCloseTab = useCallback(
    (leafId: string, ref: TabRef) => {
      // Closing an untitled tab discards its profile-store draft — confirm
      // first (the dialogue below); nothing else lists orphaned drafts.
      if (ref.type === 'editor' && tabKind(ref.tab) === 'untitled') {
        setDiscardingUntitled({ leafId, ref });
        return;
      }
      // Remember where it sat so `tab.reopen` can put it back in the same pane
      // at the same position (SPEC §11). Untitled drafts return above: closing
      // one DELETES it, so there is nothing to reopen.
      const from = findLeaf(layout.tree, leafId);
      const index = from?.tabs.findIndex((t) => tabRefKey(t) === tabRefKey(ref)) ?? -1;
      rememberClosedTab(scopeKey, { leafId, index: Math.max(0, index), ref });
      layout.close(leafId, ref);
      if (ref.type === 'terminal' && ref.session === activeSessionId) {
        justClosedActive.current = ref.session;
        uiState.update({ active_session: null });
        void navigate(`/project/${projectId}`);
      }
    },
    [layout, activeSessionId, uiState, navigate, projectId, scopeKey],
  );
  // `tab.reopen`: put the last closed tab back where it was — same pane, same
  // position in its strip — through the very path a drag takes (`center` drop),
  // so it lands permanent and focused. A closure whose session has since gone is
  // discarded rather than resurrected; while the full session list is still
  // loading nothing is known to be dead, so everything stays reopenable.
  const reopenClosedTab = useCallback(() => {
    const live = allSessionsRef.current;
    const alive = live
      ? new Set(live.filter((s) => s.status !== 'archived').map((s) => s.id))
      : null;
    const entry = takeClosedTab(scopeKey, (ref) => {
      if (alive === null) return true;
      const sid = ref.type === 'terminal' ? ref.session : ref.tab.session;
      return alive.has(sid);
    });
    if (!entry) return;
    const { ref } = entry;
    // The pane it came from may itself be gone (a leaf that loses its last tab
    // collapses): then the tab joins the pane being worked in, appended rather
    // than forced to a position in a strip it never belonged to.
    const home = findLeaf(layout.tree, entry.leafId);
    const leafId = home ? entry.leafId : layout.focusedLeaf.id;
    const index = home ? entry.index : undefined;
    layout.drop({ ref, fromLeafId: leafId, toLeafId: leafId, edge: 'center', index });
    // A reopened terminal claims the URL, exactly as activating its tab does.
    if (ref.type === 'terminal' && ref.session !== activeSessionId) {
      const owner = tabSessions.find((s) => s.id === ref.session)?.project_id;
      if (owner) void navigate(`/project/${owner}/session/${ref.session}`);
    }
  }, [layout, scopeKey, activeSessionId, tabSessions, navigate]);
  // A sidebar drag (file row / session row or dot) dropped onto a pane: open a
  // PERMANENT tab there through the same dropTab path strip drags use — centre
  // inserts, an edge splits — so a drag opens and positions in one gesture.
  // As an OPEN (`copy`), not a move: a file already open elsewhere gains a
  // second tab sharing its buffer rather than being yanked from its pane
  // (dropTab keeps terminals unique — those still move). A dropped session
  // also claims the URL, like activating its tab would.
  const onDropTab = useCallback(
    (leafId: string, ref: TabRef, edge: DropEdge) => {
      const owner =
        ref.type === 'terminal'
          ? tabSessions.find((s) => s.id === ref.session)?.project_id
          : undefined;
      // Under project-based layouts, a session from another project belongs in
      // THAT project's tree — dropping it here would file it under this project
      // and then navigate away from the pane it landed in, so the tab vanished
      // with the layout it was filed in. Switch projects and open it there
      // instead, permanent as a drop implies. The dropped POSITION cannot
      // follow: it names a pane in a tree that is not the destination's.
      if (projectScoped && owner !== undefined && owner !== projectId && ref.type === 'terminal') {
        pendingOpen.current = { session: ref.session, pin: true };
        void navigate(`/project/${owner}/session/${ref.session}`);
        return;
      }
      layout.drop({ ref, fromLeafId: leafId, toLeafId: leafId, edge, copy: true });
      if (ref.type === 'terminal' && ref.session !== activeSessionId && owner !== undefined) {
        void navigate(`/project/${owner}/session/${ref.session}`);
      }
    },
    [layout, activeSessionId, tabSessions, navigate, projectScoped, projectId],
  );

  // The whole left sidebar binds to one worktree: the pinned session if any,
  // otherwise the FOCUSED pane's active tab — every tab carries the worktree
  // it was opened from (a file tab its `session`, a terminal its own), so
  // Files, Changes, and Search follow whichever tab you are working in; the
  // URL-bound session is only the fallback for an empty pane (SPEC §8,
  // pin-across-tabs). Resolved against the full session list so cross-project
  // tabs and profile-wide pins bind while you visit another project.
  const focusedRef =
    layout.focusedLeaf.tabs.find((t) => tabRefKey(t) === layout.focusedLeaf.activeKey) ?? null;
  const rawFocusedSession =
    focusedRef === null
      ? null
      : focusedRef.type === 'terminal'
        ? focusedRef.session
        : focusedRef.tab.session;
  // An untitled tab binds to nothing (nil-uuid session) — fall through to the
  // URL-bound session rather than looking up a session that cannot exist.
  const focusedTabSession = rawFocusedSession === UNTITLED_SESSION ? null : rawFocusedSession;
  // …and when nothing qualifies — no session in focus, none in this project, or
  // none created yet — the sidebar binds to the PROJECT'S OWN directory rather
  // than showing four empty panels (SPEC §8, decision 2026-08-03). The daemon
  // resolves that through a directory target, so an older one keeps the empty
  // state instead of asking questions it would answer about the wrong repo.
  const repo = useRepos().data?.find((r) => r.id === project?.repo_id);
  const projectDirectory = useMemo(
    () =>
      directoryTargetSupported(daemonProtocol) && repo && project
        ? {
            path: repo.path,
            projectId: project.id,
            name: project.name,
            defaultBranch: repo.default_base_branch,
          }
        : null,
    [daemonProtocol, repo, project],
  );
  const sidebarTarget = useExplorerTarget(
    tabSessions,
    focusedTabSession ?? activeSessionId,
    uiState,
    projectDirectory,
  );
  const targetSession = sidebarTarget.session;
  const targetRoot = sidebarTarget.root;
  const revealFileTab = useCallback(
    (tab: EditorTab) => {
      const owner = tabSessions.find((session) => session.id === tab.session);
      if (tab.root === undefined && !owner) return;
      const currentFiletreeRoot =
        filetreeRootRef.current ?? targetRoot ?? targetSession?.worktree_path ?? null;
      const target = fileTabRevealTarget(
        tab,
        owner?.worktree_path ?? tab.root ?? '',
        currentFiletreeRoot,
      );

      if (isNarrowRef.current) setNarrowNav(true);
      uiState.update({
        sidebar_mode: 'files',
        ...(isNarrowRef.current ? {} : { sidebar_collapsed: false }),
      });

      if (target.browseRoot !== undefined) {
        // The standard ephemeral browse route used by command-palette paths and
        // terminal directory links: pin a live owner (a project-directory tab
        // carries the nil session id, which is not itself pinnable) and rebase
        // Files.
        const browseSession = owner?.id ?? targetSession?.id ?? tab.session;
        setBrowseRequest({ session: browseSession, root: target.browseRoot, nonce: Date.now() });
      } else {
        if (currentFiletreeRoot !== target.directory) sidebarTarget.pin(tab.session);
      }
      requestReveal({
        path: target.path,
        directory: target.directory,
      });
    },
    [sidebarTarget, tabSessions, targetRoot, targetSession?.worktree_path, uiState],
  );
  const renameFileTab = useCallback(
    async (tab: EditorTab, newName: string): Promise<boolean> => {
      const trimmed = newName.trim();
      if (trimmed === '' || trimmed === basename(tab.path)) return true;
      const nextPath = joinPath(dirOf(tab.path), trimmed);
      try {
        // Load the lazy buffer module BEFORE touching disk. If the editor chunk
        // could not load, the file stays where it is and no dirty model is left
        // stranded under the old path.
        const { rekeyBuffer } = await import('../editor/buffers/buffer-store');
        const result = await renameEntry(tab.session, tab.path, nextPath, tab.root);
        const snapshot = rekeyBuffer(tab.session, tab.path, result.path, tab.root);
        layoutRef.current.renameFile(tab, result.path);
        void qc.invalidateQueries({ queryKey: ['wt-tree', tab.session] });
        void qc.invalidateQueries({ queryKey: ['wt-git-status', tab.session] });

        // The old editor body's cleanup flushes its debounced draft during the
        // layout render. Run one task later so that old-key write finishes first,
        // then preserve dirty text under the new identity and retire the orphan.
        setTimeout(() => {
          const moved = snapshot?.dirty
            ? saveDraft(tab.session, result.path, snapshot.content, snapshot.baseMtimeMs, tab.root)
            : Promise.resolve();
          void moved.then(() => deleteDraft(tab.session, tab.path, tab.root));
        }, 0);
        return true;
      } catch (error) {
        toastError(error);
        return false;
      }
    },
    [qc],
  );
  const openFromTerminal = useCallback(
    (session: string, target: FileLinkTarget) => {
      if (target.kind === 'dir') {
        if (isNarrowRef.current) setNarrowNav(true);
        uiState.update({
          sidebar_mode: 'files',
          ...(isNarrowRef.current ? {} : { sidebar_collapsed: false }),
        });
        setBrowseRequest({ session, root: target.path, nonce: Date.now() });
        return;
      }
      const browseRoot = externalBrowseRoot(target, targetRoot);
      if (browseRoot !== null) {
        // An external file's containing directory becomes the shared Files /
        // Changes / Search location even when the current navigator stays put.
        setBrowseRequest({ session, root: browseRoot, nonce: Date.now() });
      }
      openFile(
        session,
        target.path,
        target.line !== undefined ? { line: target.line, column: target.column } : undefined,
        target.root !== undefined ? { root: target.root } : undefined,
      );
    },
    [openFile, uiState, targetRoot],
  );
  const pathSessionId = targetSession?.id ?? null;
  const openTypedPath = useCallback(
    async (path: string) => {
      if (pathSessionId === null) throw new Error('No worktree is available for this project.');
      const target = await resolveFileLinkTarget(pathSessionId, path, { root: targetRoot });
      // A project-directory target uses the nil session id plus `root`. Files
      // resolving inside that directory omit `root` in the response (they are
      // inside the resolution base), so restore it for the external-tab API.
      const rootedTarget: FileLinkTarget =
        target.kind === 'file' && target.root === undefined && targetRoot !== undefined
          ? { ...target, root: targetRoot }
          : target;
      if (rootedTarget.kind === 'dir' && rootedTarget.relativePath !== undefined) {
        if (isNarrowRef.current) setNarrowNav(true);
        uiState.update({
          sidebar_mode: 'files',
          ...(isNarrowRef.current ? {} : { sidebar_collapsed: false }),
        });
        requestReveal({
          path: rootedTarget.relativePath,
          root: targetRoot,
          expandTarget: true,
        });
        return;
      }
      openFromTerminal(pathSessionId, rootedTarget);
    },
    [pathSessionId, targetRoot, openFromTerminal],
  );
  useEffect(() => registerOpenPathHandler(openTypedPath), [openTypedPath]);
  const sidebarMode: SidebarMode = normalizeSidebarMode(uiState.snapshot.sidebar_mode);
  const sidebarCollapsed = uiState.snapshot.sidebar_collapsed;
  const sessionsCollapsed = uiState.snapshot.sessions_collapsed;

  // Insert a Scratchpad entry into the focused terminal's stdin, wrapped in
  // bracketed-paste so a multi-line prompt lands as one paste and the agent
  // never submits on an embedded newline (SPEC §11). Only a focused *terminal*
  // tab accepts stdin; otherwise nudge the user to focus one.
  const insertPrompt = useCallback(
    (text: string) => {
      const leaf = layout.focusedLeaf;
      const ref = leaf.tabs.find((t) => tabRefKey(t) === leaf.activeKey) ?? null;
      if (!ref || ref.type !== 'terminal') {
        toast.error('Focus a terminal or agent to insert');
        return;
      }
      wsManager.write(ref.session, 'agent', `\x1b[200~${text}\x1b[201~`);
    },
    [layout],
  );
  // The top-bar Scratchpad popover pastes entries through this workspace's
  // focused terminal while it is mounted (scratchpad-store).
  useEffect(() => {
    setScratchpadInsertHandler(insertPrompt);
    return () => setScratchpadInsertHandler(null);
  }, [insertPrompt]);

  // Load a saved layout (SPEC §11): `loadLayoutPatch` is the whole
  // transformation — the patch is applied BEFORE the setting flips, so the
  // one-shot transition effect above finds nothing to convert and the default
  // union/shard cannot overwrite the layout being loaded.
  const applyLayout = useCallback(
    (saved: SavedLayout): boolean => {
      const base = baseUiStateRef.current;
      const live = allSessionsRef.current;
      const projects = profileProjectsRef.current;
      if (!base.loaded || !live || !projects) return false;
      const { patch, projectBased } = loadLayoutPatch(base.current(), saved, {
        alive: new Set(live.filter((s) => s.status !== 'archived').map((s) => s.id)),
        sessionProject: new Map(live.map((s) => [s.id, s.project_id])),
        projectIds: projects.map((p) => p.id),
        currentProject: projectId,
      });
      base.update(patch);
      if (clientSettings().projectBasedLayout !== projectBased) {
        updateClientSettings({ projectBasedLayout: projectBased });
      }
      return true;
    },
    [projectId],
  );

  // The top-bar Layouts popover reads the live layout — and loads saved ones —
  // through this bridge while a workspace is mounted (layouts-store). The
  // scoped snapshot keeps `layout_ref`/`layout_tree` pointing at whichever
  // slice is live, so the bridge is mode-agnostic.
  const savedScope = projectScoped ? 'project' : 'profile';
  const scopedTree = uiState.snapshot.layout_tree;
  const scopedLayoutRef = uiState.snapshot.layout_ref;
  const projectLayouts = baseUiState.snapshot.project_layouts;
  useEffect(() => {
    if (!baseUiState.loaded) return;
    setLayoutBridge({
      scope: savedScope,
      projectId,
      layoutRef: scopedLayoutRef,
      signature: layoutSignature(scopedTree),
      // Every stored slice, not just this project's: other projects' current
      // layouts (project mode) or slices preserved through a profile-load —
      // a cross-project load replaces one of THESE, and the popover confirms
      // against exactly what it replaces.
      slices: Object.fromEntries(
        Object.entries(projectLayouts).map(([pid, slice]) => [
          pid,
          { layoutRef: slice.layout_ref, signature: layoutSignature(slice.layout_tree) },
        ]),
      ),
      capture: () => {
        const cur = uiStateRef.current.current();
        return { layout_tree: cur.layout_tree, active_session: cur.active_session };
      },
      apply: applyLayout,
    });
  }, [
    baseUiState.loaded,
    savedScope,
    projectId,
    scopedTree,
    scopedLayoutRef,
    projectLayouts,
    applyLayout,
  ]);
  useEffect(() => () => setLayoutBridge(null), []);

  // Global hotkey handlers (SPEC §11): register stable wrappers once; each reads
  // the latest closures from a ref so re-renders don't churn the registry.
  const hkRef = useRef<Record<string, () => void>>({});
  // Step through the FOCUSED pane's strip, wrapping at both ends — the tab
  // cycling hotkeys (SPEC §11). It goes through `onActivateTab`, so cycling onto
  // a terminal claims the URL exactly as clicking its chip would.
  const cycleTab = (step: 1 | -1) => {
    const leaf = layout.focusedLeaf;
    if (leaf.tabs.length < 2) return;
    const at = leaf.tabs.findIndex((t) => tabRefKey(t) === leaf.activeKey);
    // No active tab (an empty-ish pane): step in from the near end.
    const next = at === -1 ? (step === 1 ? 0 : leaf.tabs.length - 1) : at + step;
    const ref = leaf.tabs[(next + leaf.tabs.length) % leaf.tabs.length];
    if (ref) onActivateTab(leaf.id, ref);
  };
  const openNavigator = (mode: SidebarMode) => {
    if (isNarrow) {
      uiState.update({ sidebar_mode: mode });
      setNarrowNav(true);
    } else {
      uiState.update({ sidebar_mode: mode, sidebar_collapsed: false });
    }
  };
  hkRef.current = {
    'tab.close': () => {
      const leaf = layout.focusedLeaf;
      const ref = leaf.tabs.find((t) => tabRefKey(t) === leaf.activeKey);
      if (ref) onCloseTab(leaf.id, ref);
    },
    'tab.reopen': reopenClosedTab,
    // The keyboard route to the strip's double-click gesture: a fresh untitled
    // draft in the focused pane (SPEC §8).
    'tab.newUntitled': () => onNewUntitled(layout.focusedLeaf),
    'tab.next': () => cycleTab(1),
    'tab.prev': () => cycleTab(-1),
    // Save is captured by the shell before Monaco and routed through this
    // LOGICAL active tab. A draggable chip can focus this pane while the DOM
    // caret remains in another pane's Monaco; document.activeElement must not
    // decide which file is written (SPEC §8).
    'editor.save': () => {
      requestActiveTabSave(layout.activeEditorTab);
    },
    'sidebar.left': () =>
      isNarrow
        ? setNarrowNav((v) => !v)
        : uiState.update({ sidebar_collapsed: !uiState.snapshot.sidebar_collapsed }),
    'sidebar.right': () =>
      isNarrow
        ? setNarrowSessions((v) => !v)
        : uiState.update({ sessions_collapsed: !uiState.snapshot.sessions_collapsed }),
    'nav.files': () => openNavigator('files'),
    'nav.search': () => openNavigator('search'),
    'nav.changes': () => openNavigator('changes'),
    'nav.worktrees': () => openNavigator('worktrees'),
    'session.newAgent': () => openCreate('agent'),
    'session.newTerminal': () => openCreate('terminal'),
    // 'scratchpad.toggle' is registered by the top-bar popover (SPEC §11).
  };
  useEffect(() => {
    const ids = Object.keys(hkRef.current);
    const unregs = ids.map((id) => registerHotkey(id, () => hkRef.current[id]?.()));
    return () => unregs.forEach((u) => u());
  }, []);

  // Highlight the navigator entry for the focused pane's active editor tab.
  const activeTab = layout.activeEditorTab;
  const activeDiffPath =
    activeTab?.kind === 'diff' && targetSession && activeTab.session === targetSession.id
      ? activeTab.path
      : null;
  // Highlight the files-tree row whose file is the active editor tab (a legacy
  // snapshot's tab has no `kind`, meaning `file`).
  const activeFilePath =
    activeTab &&
    (activeTab.kind ?? 'file') === 'file' &&
    targetSession &&
    activeTab.session === targetSession.id
      ? activeTab.path
      : null;
  // The same highlight for the browse tree above the worktree: an `external`
  // tab's path is relative to its own root, so the row only matches when that
  // root is the one currently being browsed (the sidebar decides).
  const activeExternalTab =
    activeTab?.kind === 'external' && activeTab.root !== undefined
      ? { path: activeTab.path, root: activeTab.root }
      : null;

  // A changes / commit-file / search-result click opens its content as a
  // centre-editor tab against the BOUND worktree (openEditorTab dedupes). Under
  // a directory target the tab carries that directory as its `root`, which is
  // both what its requests send and what keys it apart from a worktree tab for
  // the same relative path (SPEC §8).
  // Every one of them opens PREVIEW by default, exactly as a files-tree click
  // does (SPEC §8): a single click on a result is a peek that the next click
  // replaces in the same slot, and a double click — on the row or on its tab —
  // pins it. `opts.preview === false` is the pin.
  type OpenOpts =
    | {
        preview?: boolean;
        root?: string;
        gitArea?: import('@puddle/shared').GitArea;
      }
    | undefined;
  const previewing = (opts: OpenOpts) => ({ preview: opts?.preview ?? true });
  const openDiff = (path: string, opts?: OpenOpts) => {
    if (targetSession) {
      const diffRoot = opts?.root ?? targetRoot;
      const diffRooted = diffRoot === undefined ? {} : { root: diffRoot };
      openEditorTab(
        {
          kind: 'diff',
          session: targetSession.id,
          path,
          ...diffRooted,
          ...(opts?.gitArea === undefined ? {} : { git_area: opts.gitArea }),
        },
        undefined,
        previewing(opts),
      );
    }
  };
  const openCommitFile = (path: string, sha: string, opts?: OpenOpts) => {
    if (targetSession) {
      const commitRoot = opts?.root ?? targetRoot;
      const commitRooted = commitRoot === undefined ? {} : { root: commitRoot };
      openEditorTab(
        { kind: 'commit', session: targetSession.id, path, sha, ...commitRooted },
        undefined,
        previewing(opts),
      );
    }
  };
  const openSearchFile = (path: string, line?: number, opts?: OpenOpts) => {
    if (!targetSession) return;
    const position = line !== undefined ? { line, column: 1 } : undefined;
    // A directory target's files are `external` tabs — the kind that carries a
    // root through the editor, its buffer, its drafts, and its save.
    if (targetRoot !== undefined) {
      openEditorTab(
        { kind: 'external', session: targetSession.id, path, root: targetRoot },
        position,
        previewing(opts),
      );
      return;
    }
    openFile(targetSession.id, path, position, previewing(opts));
  };

  // The horizontal shell (nav | main | sessions) persists its sizes into the
  // flat `layout` object via `layoutForPanels`/merge, exactly as before — the
  // tiling area inside `main` carries its own per-split sizes in `layout_tree`.
  // `onLayoutChanged` merges the shell's keys so it never wipes unrelated ones.
  const mergeLayout = useCallback(
    (next: Layout) => uiState.update({ layout: { ...uiState.snapshot.layout, ...next } }),
    [uiState],
  );
  // The nav and sessions panels join the horizontal Group only while expanded
  // (collapsed, a slim rail sits outside the Group), keeping the restore count exact.
  const horizontalLayout = layoutForPanels(uiState.snapshot.layout, [
    ...(sidebarCollapsed ? [] : ['nav']),
    'main',
    ...(sessionsCollapsed ? [] : ['sessions']),
  ]);

  if (!validProject) return null;
  // The gate needs the project ROW, not its detail: within a profile the row is
  // already in hand when the URL changes, so switching projects renders straight
  // into the new one (its session list arriving a beat later) instead of
  // replacing the workspace with a spinner.
  if (!uiState.loaded || !project || !chunksReady) {
    return <div className="flex h-full items-center justify-center text-sm text-fg-muted">…</div>;
  }

  // The sidebars render identically in both layouts; only the collapse/close
  // action differs (panel-collapse on desktop, overlay-dismiss on a phone).
  const navigatorPanel = (onCollapse: () => void) => (
    <NavigatorSidebar
      mode={sidebarMode}
      onModeChange={(m) => uiState.update({ sidebar_mode: m })}
      onCollapse={onCollapse}
      projectId={projectId}
      repoId={project.repo_id}
      sessions={sessions}
      target={sidebarTarget}
      browseRequest={browseRequest}
      onFiletreeRootChange={rememberFiletreeRoot}
      compilableExtensions={compilableExtensions}
      onOpenCompilationSettings={commandSettingsAvailable ? openCompilationSettings : undefined}
      onOpenFile={openTreeFile}
      onOpenExternalFile={openExternalFile}
      onOpenTerminalIn={openTerminalIn}
      activeFilePath={activeFilePath}
      activeExternalTab={activeExternalTab}
      activeDiffPath={activeDiffPath}
      onOpenDiff={openDiff}
      onOpenCommitFile={openCommitFile}
      onOpenSearchFile={openSearchFile}
    />
  );
  const projectActions = {
    onNewSessionIn: (pid: string) => openCreateIn('agent', pid),
    onNewTerminalIn: (pid: string) => openCreateIn('terminal', pid),
    onMoveProject: moveProject,
  };
  const sessionsPanel = (onCollapse: () => void) => (
    <SessionSidebar
      groups={sessionGroups}
      accounts={accounts}
      activeSessionId={activeSessionId}
      onReorder={persistReorder}
      onPromote={(id) => layout.ensureTerminal(id)}
      archived={archivedSessions}
      onNewSession={() => openCreate('agent')}
      onNewTerminal={() => openCreate('terminal')}
      onCollapse={onCollapse}
      onArchived={closeTab}
      onArchiveDrop={(ids) => void archiveSidebarSessions(ids)}
      selection={sidebarSessionSelection}
      projectActions={projectActions}
    />
  );

  // Free-form tiling area (SPEC §8): editor and terminal tabs live in a
  // recursive split tree (`layout_tree`); every open terminal is kept mounted
  // by `KeepAliveHost` and its DOM adopted into whichever pane shows it, so
  // PTYs never drop. A session's resume button and ports overlay the
  // bottom-right of ITS OWN pane (PaneSessionOverlay). The DnD context wraps
  // the WHOLE workspace (not just this area) so a strip drag can land on the
  // sidebar's archive targets.
  const phoneSession =
    sessions.find((session) => session.id === phoneSelection)?.id ??
    sessions.find((session) => session.id === activeSessionId)?.id ??
    null;
  const mainArea = isNarrow ? (
    <LocalPhonePane
      sessions={sessions}
      selected={phoneSession}
      select={(id) => {
        setPhoneSelection(id);
        setPhoneVisited((ids) => (ids.includes(id) ? ids : [...ids, id]));
      }}
    />
  ) : (
    <div className="flex h-full flex-col bg-ground">
      {eagerCompilationTargets.map(({ key, leafId, target }) => (
        <CompilationWatcher
          key={key}
          sourceKey={key}
          leafId={leafId}
          target={target}
          onResult={onEagerCompilationResult}
          onError={onEagerCompilationError}
          onRunningChange={setEagerCompilationRunning}
        />
      ))}
      <div className="min-h-0 flex-1">
        <TileTree
          tree={layout.tree}
          sessions={tabSessions}
          reveal={reveal}
          onActivateTab={onActivateTab}
          onCloseTab={onCloseTab}
          onPromoteTab={promoteTab}
          onArchived={closeTab}
          onFocusLeaf={focusLeaf}
          onScrollDrive={claimScrollDriver}
          onResize={layout.resize}
          onDropTab={onDropTab}
          onSetTabView={layout.setView}
          compilableExtensions={compilableExtensions}
          compilationProviders={availableCompilationProviders}
          compilationRunningKeys={compilationRunningKeys}
          onRunCompilation={(leafId, tab, copy) => void onRunCompilation(leafId, tab, copy)}
          onSetCompilationMode={onSetCompilationMode}
          onOpenCompilationSettings={commandSettingsAvailable ? openCompilationSettings : undefined}
          onRevealPreviewSource={revealPreviewSource}
          onRevealCompiledSource={revealCompiledSource}
          onNewUntitled={onNewUntitled}
          onRevealFile={revealFileTab}
          onRenameFile={renameFileTab}
          focusedLeafId={layout.focusedLeaf.id}
          scrollDriverLeafId={scrollDriverLeafId}
          scrollChannel={`${profileId ?? ''}:${scopeKey}`}
        />
      </div>
    </div>
  );

  // KeepAliveHost wraps BOTH layouts: crossing the breakpoint (a tablet
  // rotation, a resized window) swaps the shell without remounting it, so
  // open terminals keep their scrollback and PTY attachments. Under
  // project-based layout it also holds the OTHER projects' terminals (parked,
  // detached) so switching project parks them instead of rebuilding them.
  return (
    <KeepAliveHost
      tree={layout.tree}
      parked={[...parkedSessions, ...phoneVisited, ...(phoneSession ? [phoneSession] : [])]}
      onOpenFile={openFromTerminal}
    >
      <TilingDnd
        onDrop={layout.drop}
        onArchive={(id) => void archiveSidebarSessions([id])}
        renderOverlay={(ref) => {
          const s =
            ref.type === 'terminal' ? tabSessions.find((x) => x.id === ref.session) : undefined;
          const label =
            ref.type === 'terminal'
              ? s
                ? renderTitle(s)
                : ref.session.slice(0, 8)
              : (ref.tab.path.split('/').pop() ?? ref.tab.path);
          return (
            <div className="rounded-md bg-elevated px-2.5 py-1 text-xs text-fg shadow-lg">
              {label}
            </div>
          );
        }}
      >
        <div className="relative flex h-full min-h-0 overflow-hidden">
          {isNarrow ? (
            /* Narrow (SPEC §12): both rails stay put; expanding opens the sidebar
             as an overlay above the tiling area — a translucent ground dims
             what stays behind (HUMANS.md transparency, no borders). */
            <>
              <CollapsedSidebarRail
                mode={sidebarMode}
                onExpand={() => setNarrowNav(true)}
                onSelect={(m) => {
                  uiState.update({ sidebar_mode: m });
                  setNarrowNav(true);
                }}
              />
              <div className="min-w-0 flex-1">{mainArea}</div>
              <CollapsedSessionsRail
                groups={sessionGroups}
                accounts={accounts}
                activeSessionId={activeSessionId}
                onReorder={persistReorder}
                onPromote={(id) => layout.ensureTerminal(id)}
                onExpand={() => setNarrowSessions(true)}
                onNewTerminal={() => openCreate('terminal')}
                onNewSession={() => openCreate('agent')}
                onArchived={closeTab}
                onArchiveDrop={(ids) => void archiveSidebarSessions(ids)}
                selection={sidebarSessionSelection}
                projectActions={projectActions}
              />
              {narrowNav && (
                <>
                  <button
                    type="button"
                    aria-label="Close the navigator"
                    className="absolute inset-0 z-30 bg-ground/60"
                    onClick={() => setNarrowNav(false)}
                  />
                  <div className="absolute inset-y-0 left-9 z-40 w-[min(20rem,calc(100%-4.5rem))] shadow-xl">
                    {navigatorPanel(() => setNarrowNav(false))}
                  </div>
                </>
              )}
              {narrowSessions && (
                <>
                  <button
                    type="button"
                    aria-label="Close the session list"
                    className="absolute inset-0 z-30 bg-ground/60"
                    onClick={() => setNarrowSessions(false)}
                  />
                  <div className="absolute inset-y-0 right-9 z-40 w-[min(20rem,calc(100%-4.5rem))] shadow-xl">
                    {sessionsPanel(() => setNarrowSessions(false))}
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              {sidebarCollapsed && (
                <CollapsedSidebarRail
                  mode={sidebarMode}
                  onExpand={() => uiState.update({ sidebar_collapsed: false })}
                  onSelect={(m) => uiState.update({ sidebar_collapsed: false, sidebar_mode: m })}
                />
              )}
              <Group
                orientation="horizontal"
                className="h-full min-w-0 flex-1"
                defaultLayout={horizontalLayout}
                onLayoutChanged={mergeLayout}
              >
                {!sidebarCollapsed && (
                  <>
                    <Panel id="nav" defaultSize={280} minSize={200} maxSize={560}>
                      {navigatorPanel(() => uiState.update({ sidebar_collapsed: true }))}
                    </Panel>
                    <Separator className="w-px bg-border transition-colors hover:bg-accent data-[resizing]:bg-accent" />
                  </>
                )}
                <Panel id="main">{mainArea}</Panel>
                {!sessionsCollapsed && (
                  <>
                    <Separator className="w-px bg-border transition-colors hover:bg-accent data-[resizing]:bg-accent" />
                    <Panel id="sessions" defaultSize={260} minSize={180} maxSize={480}>
                      {sessionsPanel(() => uiState.update({ sessions_collapsed: true }))}
                    </Panel>
                  </>
                )}
              </Group>
              {sessionsCollapsed && (
                <CollapsedSessionsRail
                  groups={sessionGroups}
                  accounts={accounts}
                  activeSessionId={activeSessionId}
                  onReorder={persistReorder}
                  onPromote={(id) => layout.ensureTerminal(id)}
                  onExpand={() => uiState.update({ sessions_collapsed: false })}
                  onNewTerminal={() => openCreate('terminal')}
                  onNewSession={() => openCreate('agent')}
                  onArchived={closeTab}
                  onArchiveDrop={(ids) => void archiveSidebarSessions(ids)}
                  selection={sidebarSessionSelection}
                  projectActions={projectActions}
                />
              )}
            </>
          )}
          <NewSessionDialog
            projectId={createTarget?.projectId ?? projectId}
            repoId={createTarget?.repoId ?? project.repo_id}
            open={creating}
            kind={createKind}
            seedAccountId={seedAccountId}
            onOpenChange={setCreating}
            // Navigate to the session's OWN project — a header context menu can
            // create it in a project other than the one the URL names.
            onCreated={(session) =>
              void navigate(`/project/${session.project_id}/session/${session.id}`)
            }
          />
          <UntitledSaveDialog
            request={savingUntitled}
            targetSession={targetSession}
            targetRoot={targetRoot}
            targetLabel={
              targetSession === null
                ? ''
                : targetRoot !== undefined
                  ? targetRoot
                  : targetSession.branch
            }
            profileId={profileId}
            onClose={() => setSavingUntitled(null)}
            onSaved={finishUntitledSave}
          />
          <CompilationSettingsDialog
            request={compilationSettingsRequest}
            onOpenChange={(open) => !open && setCompilationSettingsRequest(null)}
          />
          <Dialog
            open={discardingUntitled !== null}
            onOpenChange={(open) => !open && setDiscardingUntitled(null)}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Discard this draft?</DialogTitle>
                <DialogDescription>
                  Closing an untitled tab deletes its draft — {saveKey} saves it into the worktree
                  instead.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setDiscardingUntitled(null)}>
                  Keep editing
                </Button>
                <Button variant="danger" onClick={confirmDiscardUntitled}>
                  Discard
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </TilingDnd>
    </KeepAliveHost>
  );
}
