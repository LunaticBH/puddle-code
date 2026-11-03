import type { Project, Session, SessionStatus } from '@puddle/shared';
import { appearanceColourClass } from '../../lib/appearance/appearance-colours';
import { cn } from '../../lib/utils';

/** Shared by the desktop dashboard and the host-grouped remote dashboard. */
export const projectCardSurface =
  'group block w-full rounded-lg bg-surface p-4 text-left transition-colors hover:bg-elevated';

const COUNTED: Array<{ status: SessionStatus; colour: string }> = [
  { status: 'running', colour: 'bg-running' },
  { status: 'waiting_input', colour: 'bg-waiting' },
  { status: 'interrupted', colour: 'bg-interrupted' },
];

export function ProjectCardContent({
  project,
  repoPath,
  sessions,
}: {
  project: Project;
  repoPath?: string;
  sessions: Session[];
}) {
  const active = sessions.filter((session) => session.status !== 'archived');
  return (
    <>
      <h2
        className={cn(
          'truncate pr-16 text-base font-semibold',
          appearanceColourClass(project.colour) || 'text-fg group-hover:text-accent',
        )}
      >
        {project.name}
      </h2>
      <p className="mt-1 truncate text-2xs text-fg-muted">{repoPath ?? '…'}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-2xs text-fg-muted tabular-nums">
        <span>
          {active.length} session{active.length === 1 ? '' : 's'}
        </span>
        {COUNTED.map(({ status, colour }) => {
          const count = active.filter((session) => session.status === status).length;
          return count > 0 ? (
            <span key={status} className="flex items-center gap-1">
              <span className={`size-1.5 rounded-full ${colour}`} />
              {count} {status.replace('_', ' ')}
            </span>
          ) : null;
        })}
      </div>
    </>
  );
}
