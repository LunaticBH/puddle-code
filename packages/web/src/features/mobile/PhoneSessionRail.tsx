import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Bot,
  SquareTerminal,
} from 'lucide-react';
import type { Project, Session, SessionKind } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { projectAbbrev } from '../../lib/project-abbrev';
import { sessionDisplayName } from '../../lib/session-display';
import { cn } from '../../lib/utils';
import { appearanceColourClass } from '../../lib/appearance/appearance-colours';
import { SessionGlyph } from '../status/SessionGlyph';

export function PhoneSessionRail({
  projects,
  projectId,
  sessions,
  selected,
  connected,
  chooseProject,
  choose,
  create,
  inspect,
}: {
  projects: Project[];
  projectId: string;
  sessions: Session[];
  selected?: string;
  connected: boolean;
  chooseProject(id: string): void;
  choose(session: Session): void;
  create(kind: SessionKind): void;
  inspect(session: Session): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [archive, setArchive] = useState(false);
  const archived = sessions.filter(
    (session) => session.project_id === projectId && session.status === 'archived',
  );
  return (
    <>
      {expanded && (
        <button
          className="phone-rail-backdrop"
          aria-label="Close session list"
          onClick={() => setExpanded(false)}
        />
      )}
      <aside className={cn('phone-session-rail', expanded && 'is-expanded')} aria-label="Sessions">
        <div className="flex shrink-0 flex-col px-1">
          <Button
            variant="ghost"
            className="rail-control rail-toggle"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? 'Collapse sessions' : 'Expand sessions'}
            aria-expanded={expanded}
          >
            {expanded ? <PanelLeftClose /> : <PanelLeftOpen />}
            {expanded && <span>Sessions</span>}
          </Button>
          <Button
            variant="ghost"
            className="rail-control"
            disabled={!connected || !projectId}
            onClick={() => create('agent')}
            aria-label="New agent"
          >
            <Bot />
            {expanded && <span>New agent</span>}
          </Button>
          <Button
            variant="ghost"
            className="rail-control"
            disabled={!connected || !projectId}
            onClick={() => create('terminal')}
            aria-label="New terminal"
          >
            <SquareTerminal />
            {expanded && <span>New terminal</span>}
          </Button>
        </div>
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
          {projects
            .filter((project) => !project.archived)
            .map((project) => (
              <div key={project.id} className="phone-session-group">
                <button
                  className={cn('phone-project-label', project.id === projectId && 'text-fg')}
                  aria-label={`Switch to ${project.name}`}
                  title={project.name}
                  onClick={() => {
                    chooseProject(project.id);
                    setExpanded(false);
                  }}
                >
                  <span className={appearanceColourClass(project.colour)}>
                    {expanded ? project.name : projectAbbrev(project)}
                  </span>
                </button>
                {project.id === projectId &&
                  sessions
                    .filter(
                      (session) =>
                        session.project_id === projectId && session.status !== 'archived',
                    )
                    .map((session) => (
                      <SessionButton
                        key={session.id}
                        session={session}
                        expanded={expanded}
                        selected={selected === session.id}
                        choose={() => {
                          choose(session);
                          setExpanded(false);
                        }}
                        inspect={() => inspect(session)}
                      />
                    ))}
              </div>
            ))}
        </div>
        <div className="shrink-0 p-1">
          <Button
            variant="ghost"
            className="rail-control"
            aria-label="Archived sessions"
            onClick={() => setArchive(true)}
          >
            <Archive />
            {expanded && <span>Archived{archived.length > 0 ? ` · ${archived.length}` : ''}</span>}
          </Button>
        </div>
      </aside>
      <Dialog open={archive} onOpenChange={setArchive}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archived sessions</DialogTitle>
            <DialogDescription>
              {projects.find((project) => project.id === projectId)?.name}
            </DialogDescription>
          </DialogHeader>
          {archived.length === 0 ? (
            <p className="text-sm text-fg-muted">No archived sessions in this project.</p>
          ) : (
            <div className="grid gap-1">
              {archived.map((session) => (
                <Button
                  key={session.id}
                  variant="ghost"
                  className="h-auto justify-start py-3"
                  onClick={() => {
                    setArchive(false);
                    inspect(session);
                  }}
                >
                  <SessionGlyph
                    status={session.status}
                    kind={session.kind}
                    agentType={session.agent_type}
                    detectedAgentType={session.detected_agent_type}
                  />
                  <span className="truncate font-mono">{sessionDisplayName(session)}</span>
                </Button>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Movement cancels the hold so scrolling the rail never opens a dialogue. */
function SessionButton({
  session,
  expanded,
  selected,
  choose,
  inspect,
}: {
  session: Session;
  expanded: boolean;
  selected: boolean;
  choose(): void;
  inspect(): void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const held = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const name = sessionDisplayName(session);
  return (
    <div className="flex items-center">
      <button
        className={cn('phone-session-button', selected && 'bg-elevated')}
        aria-label={`Open session ${name}`}
        aria-current={selected ? 'page' : undefined}
        title={`${name} · ${session.status.replace('_', ' ')}`}
        onClick={() => {
          if (!held.current) choose();
          held.current = false;
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          cancel();
          held.current = true;
          inspect();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          held.current = false;
          origin.current = { x: event.clientX, y: event.clientY };
          timer.current = setTimeout(() => {
            held.current = true;
            inspect();
          }, 500);
        }}
        onPointerMove={(event) => {
          if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 10)
            cancel();
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onPointerLeave={cancel}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            inspect();
          }
        }}
      >
        <SessionGlyph
          status={session.status}
          kind={session.kind}
          agentType={session.agent_type}
          detectedAgentType={session.detected_agent_type}
          stale={session.stale_running}
          className="size-4 shrink-0"
          iconClassName="size-full"
          iconStrokeScale={0.8}
        />
        {expanded && (
          <span className="min-w-0 text-left">
            <span className="block truncate font-mono text-2xs">{name}</span>
            <span className="block truncate text-2xs text-fg-muted">
              {session.branch || session.status.replace('_', ' ')}
            </span>
          </span>
        )}
      </button>
      {expanded && (
        <Button variant="ghost" size="icon" aria-label={`Details for ${name}`} onClick={inspect}>
          <MoreHorizontal />
        </Button>
      )}
    </div>
  );
}
