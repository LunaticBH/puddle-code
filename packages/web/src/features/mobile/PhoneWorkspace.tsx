import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SquareTerminal } from 'lucide-react';
import type { NotificationTarget, Session, SessionKind } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { browserScope } from '../../lib/transport/browser-transport';
import {
  fetchProfileState,
  useAllSessions,
  useProjects,
  useRepos,
} from '../../lib/queries/queries';
import { api } from '../../lib/transport/api';
import { orderByDrag } from '../workspace/sessions/session-order';
import { loadOrderedProjects } from './project-order';
import { PhoneTerminalBar } from './PhoneTerminalBar';
import { wsManager } from '../../lib/transport/ws';
import { ProjectCardContent, projectCardSurface } from '../dashboard/ProjectCardContent';
import { profileStore } from '../profile/profile-store';
import { NewSessionDialog } from '../workspace/sessions/NewSessionDialog';
import { MobileTerminal } from './MobileTerminal';
import { PhoneFiles } from './PhoneFiles';
import { PhoneSessionRail } from './PhoneSessionRail';
import { useAgentNotifications } from '../shell/use-waiting-notifications';
import { SessionActions } from './SessionActions';

export function PhoneWorkspace({
  connected,
  initialProject,
  notificationTarget,
  hostName,
  onProjectName,
}: {
  connected: boolean;
  initialProject: string;
  notificationTarget?: NotificationTarget;
  hostName: string;
  onProjectName(name: string): void;
}) {
  useAgentNotifications((session) => {
    setRequestedSession(undefined);
    setProjectId(session.project_id);
    setSessionId(session.id);
    setView('terminals');
    setPickingProject(false);
  });
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState(initialProject);
  const [sessionId, setSessionId] = useState(
    () => localStorage.getItem(browserScope(`phone.session:${initialProject}`)) ?? '',
  );
  const [view, setView] = useState<'terminals' | 'files'>('terminals');
  const [pickingProject, setPickingProject] = useState(!initialProject);
  const [creating, setCreating] = useState<SessionKind | null>(null);
  const [inspected, setInspected] = useState<Session | null>(null);
  const [requestedSession, setRequestedSession] = useState<string>();
  const [attached, setAttached] = useState(wsManager.isConnected());
  const [terminals, setTerminals] = useState<string[]>([]);
  const projects = useProjects(undefined);
  const sessions = useAllSessions();
  useEffect(() => {
    if (!notificationTarget) return;
    setProjectId(notificationTarget.project);
    setSessionId(notificationTarget.session);
    setRequestedSession(notificationTarget.session);
    localStorage.setItem(
      browserScope(`phone.session:${notificationTarget.project}`),
      notificationTarget.session,
    );
    setView('terminals');
    setPickingProject(false);
    setInspected(null);
    setCreating(null);
    void qc.invalidateQueries({ queryKey: ['sessions'] });
  }, [notificationTarget, qc]);
  const repos = useRepos();
  const project = projects.data?.find((project) => project.id === projectId && !project.archived);
  const orderedProjects = useQuery({
    queryKey: ['phone-project-order', projects.data],
    queryFn: () => loadOrderedProjects(projects.data ?? [], (path) => api('GET', path)),
    enabled: connected && !!projects.data,
    refetchInterval: connected ? 15_000 : false,
  });
  const profileState = useQuery({
    queryKey: ['phone-profile-order', project?.profile_id],
    queryFn: () => fetchProfileState(project!.profile_id),
    enabled: connected && !!project,
    refetchInterval: connected ? 10_000 : false,
  });
  const projectRows = orderedProjects.data ?? projects.data ?? [];
  const sessionRows = orderByDrag(
    sessions.data ?? [],
    profileState.data?.ui_state.session_order ?? [],
  );
  const activeSessions = sessionRows.filter(
    (session) => session.project_id === projectId && session.status !== 'archived',
  );
  const session =
    activeSessions.find((session) => session.id === sessionId) ??
    (requestedSession ? undefined : activeSessions[0]);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['sessions'] });
  };
  useEffect(() => wsManager.onConnectionChange(setAttached), []);
  useEffect(() => {
    const changed = () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    };
    const off = [
      wsManager.onStatus(changed),
      wsManager.onSessionsChanged(changed),
      wsManager.onRenamed(changed),
    ];
    const timer = setInterval(() => {
      if (connected && !document.hidden) changed();
    }, 10_000);
    return () => {
      off.forEach((unsubscribe) => unsubscribe());
      clearInterval(timer);
    };
  }, [qc, connected]);
  useEffect(
    () =>
      wsManager.onSessionSwitched((event) => {
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        if (event.source_session !== session?.id) return;
        setProjectId(event.target_project);
        setSessionId(event.target_session);
        setView('terminals');
        localStorage.setItem(
          browserScope(`phone.session:${event.target_project}`),
          event.target_session,
        );
      }),
    [session?.id, qc],
  );
  useEffect(() => {
    if (project) profileStore.set(project.profile_id);
  }, [project]);
  useEffect(() => {
    if (!session) return;
    setTerminals((current) => (current.includes(session.id) ? current : [...current, session.id]));
  }, [session]);
  useEffect(() => {
    if (
      !session ||
      !profileState.isSuccess ||
      session.id === sessionId ||
      // A newly created or rebound placement may precede the catalogue refresh.
      // Keep that explicit selection until it arrives instead of saving a fallback.
      (sessionId && !sessionRows.some((entry) => entry.id === sessionId))
    )
      return;
    setSessionId(session.id);
    localStorage.setItem(browserScope(`phone.session:${session.project_id}`), session.id);
  }, [session, sessionId, sessionRows, profileState.isSuccess]);
  const chooseProject = (id: string) => {
    setRequestedSession(undefined);
    setProjectId(id);
    setSessionId(localStorage.getItem(browserScope(`phone.session:${id}`)) ?? '');
    setPickingProject(false);
  };
  const choose = (next: Session) => {
    setRequestedSession(undefined);
    setProjectId(next.project_id);
    setSessionId(next.id);
    setView('terminals');
    localStorage.setItem(browserScope(`phone.session:${next.project_id}`), next.id);
  };
  const showProjects = pickingProject || !project;
  const visibleProjectName = showProjects ? '' : project.name;
  useEffect(() => {
    onProjectName(visibleProjectName);
  }, [onProjectName, visibleProjectName]);
  return (
    <div className="phone-workspace">
      {requestedSession && sessions.isSuccess && !session && (
        <p role="status" className="px-3 py-2 text-xs text-fg-muted">
          This conversation is no longer available. It may have been archived or deleted.
        </p>
      )}
      <div className="phone-workspace-body">
        {!showProjects && (
          <PhoneSessionRail
            projects={projectRows}
            projectId={projectId}
            sessions={sessionRows}
            selected={session?.id}
            connected={connected}
            chooseProject={chooseProject}
            choose={choose}
            create={setCreating}
            inspect={setInspected}
          />
        )}
        <div className="phone-centre">
          {showProjects && (
            <div className="overflow-auto p-4">
              <h2 className="mb-3 text-xs text-fg-muted">{hostName}</h2>
              <div className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2">
                {projectRows
                  .filter((project) => !project.archived)
                  .map((project) => (
                    <button
                      key={project.id}
                      className={projectCardSurface}
                      aria-label={`Open ${project.name}`}
                      onClick={() => chooseProject(project.id)}
                    >
                      <ProjectCardContent
                        project={project}
                        repoPath={repos.data?.find((repo) => repo.id === project.repo_id)?.path}
                        sessions={
                          sessions.data?.filter((session) => session.project_id === project.id) ??
                          []
                        }
                      />
                    </button>
                  ))}
              </div>
              {projects.isPending && <p className="phone-empty">Loading projects…</p>}
              {projects.data?.every((project) => project.archived) && (
                <p className="phone-empty">
                  No projects yet. Open a project on this host in desktop.
                </p>
              )}
            </div>
          )}
          {!showProjects && view === 'terminals' && (
            <PhoneTerminalBar
              session={session}
              sessions={activeSessions}
              choose={choose}
              inspect={setInspected}
              files={() => setView('files')}
            />
          )}
          <div className="phone-view" hidden={showProjects}>
            {terminals
              .filter(
                (entry) =>
                  !sessions.data ||
                  sessions.data.some(
                    (session) => session.id === entry && session.status !== 'archived',
                  ),
              )
              .map((entry) => {
                const active = !showProjects && view === 'terminals' && entry === session?.id;
                return (
                  <MobileTerminal
                    key={entry}
                    session={entry}
                    term="agent"
                    active={active}
                    connected={connected}
                    attached={attached}
                  />
                );
              })}
            {!showProjects && view === 'files' && (
              <PhoneFiles
                key={session?.id ?? projectId}
                session={session?.id}
                terminals={() => setView('terminals')}
                worktree={
                  session?.worktree_path ??
                  repos.data?.find((repo) => repo.id === project?.repo_id)?.path
                }
              />
            )}
            {!showProjects && view === 'terminals' && !session && !requestedSession && (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center">
                <SquareTerminal className="size-7 text-fg-muted" />
                <p className="text-sm text-fg-muted">Start something in {project.name}.</p>
                <Button
                  variant="secondary"
                  disabled={!connected}
                  onClick={() => setCreating('agent')}
                >
                  New agent
                </Button>
                <Button
                  variant="ghost"
                  disabled={!connected}
                  onClick={() => setCreating('terminal')}
                >
                  Open terminal
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
      {(projects.error || sessions.error || orderedProjects.error || profileState.error) && (
        <p role="alert" className="px-3 py-2 text-xs text-danger">
          {projects.error?.message ||
            sessions.error?.message ||
            orderedProjects.error?.message ||
            profileState.error?.message}
        </p>
      )}
      {project && creating && (
        <NewSessionDialog
          projectId={project.id}
          repoId={project.repo_id}
          open
          kind={creating}
          accountSetup="Add an agent account in desktop Settings → Accounts, then reopen this dialogue."
          onOpenChange={(open) => {
            if (!open) setCreating(null);
          }}
          onCreated={(session) => {
            choose(session);
            void refresh();
          }}
        />
      )}
      {inspected && (
        <SessionActions
          key={inspected.id}
          session={sessions.data?.find((session) => session.id === inspected.id) ?? inspected}
          connected={connected}
          close={() => setInspected(null)}
          changed={refresh}
        />
      )}
    </div>
  );
}
