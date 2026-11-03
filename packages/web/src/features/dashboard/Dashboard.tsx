import { useState } from 'react';
import { Archive, ChevronRight, FolderGit2, FolderOpen, SquareTerminal } from 'lucide-react';
import {
  useProfileSettings,
  usePatchProfileSettings,
  useProjects,
  useRepos,
} from '../../lib/queries/queries';
import { useHotkeyLabel } from '../../lib/navigation/hotkeys';
import { cn } from '../../lib/utils';
import { orderByDrag, reorderIds } from '../workspace/sessions/session-order';
import { useCurrentProfileId } from '../profile/profile-store';
import { HomeTerminalPane, useHomeTerminal } from './HomeTerminal';
import { NewProjectDialog } from './NewProjectDialog';
import { ProjectCard } from './ProjectCard';

/** An action tile in the projects grid: the same surface as a project card. */
function ActionTile({
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  icon: typeof FolderOpen;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // flex-col so the stretched cell top-aligns the content like a card
      // (a button vertically centres its content by default).
      className="group flex flex-col rounded-lg bg-surface p-4 text-left transition-colors hover:bg-elevated"
    >
      <h2 className="flex items-center gap-2 truncate text-base font-semibold text-fg group-hover:text-accent">
        <Icon className="size-4 shrink-0" />
        {label}
      </h2>
      <p className="mt-1 truncate text-2xs text-fg-muted">{hint}</p>
    </button>
  );
}

/** The current profile's projects — creation lives in the palette, the tiles, and the empty state. */
export function Dashboard() {
  const profileId = useCurrentProfileId();
  const projects = useProjects(profileId ?? undefined);
  const repos = useRepos();
  const settings = useProfileSettings(profileId ?? undefined);
  const patchSettings = usePatchProfileSettings(profileId ?? '');
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const home = useHomeTerminal();
  const paletteKey = useHotkeyLabel('palette.toggle');

  const repoPath = (repoId: number) => repos.data?.find((r) => r.id === repoId)?.path;

  const all = projects.data ?? [];
  // New projects float to the top until dragged; archived ones drop out of the
  // grid into the disclosure below (SPEC §11).
  const order = settings.data?.projectOrder ?? [];
  const active = orderByDrag(
    all.filter((p) => !p.archived),
    order,
  );
  const archived = all.filter((p) => p.archived);

  const move = (id: string, before: string) => {
    if (id === before) return;
    patchSettings.mutate({
      projectOrder: reorderIds(
        active.map((p) => p.id),
        id,
        before,
      ),
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl p-6">
          {all.length === 0 && (
            <div className="mb-8 mt-16 flex flex-col items-center gap-3 text-center">
              <FolderGit2 className="size-8 text-fg-muted" />
              <p className="text-sm text-fg-secondary">
                No projects yet — open one below, or press {paletteKey}.
              </p>
            </div>
          )}

          {/* auto-rows-fr: every row takes the tallest row's height, so the
              action tiles match the project cards instead of hugging their
              two lines of content. */}
          <div className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2">
            {active.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                repoPath={repoPath(project.repo_id)}
                draggable
                dragging={dragging === project.id}
                onDragStart={() => setDragging(project.id)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragging && dragging !== project.id) move(dragging, project.id);
                }}
              />
            ))}
            <ActionTile
              icon={FolderOpen}
              label="Open project"
              hint="Point at a repository on this host"
              onClick={() => setCreating(true)}
            />
            <ActionTile
              icon={SquareTerminal}
              label={home.open ? 'Close terminal' : 'Open terminal'}
              hint={home.open ? 'End the shell below' : 'A shell at ~ for cloning repositories'}
              onClick={home.toggle}
            />
          </div>

          {archived.length > 0 && (
            <div className="mt-6">
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className="flex items-center gap-1.5 px-1 py-1.5 text-2xs uppercase tracking-wide text-fg-muted transition-colors hover:text-fg"
              >
                <ChevronRight
                  className={cn('size-3 transition-transform', showArchived && 'rotate-90')}
                />
                <Archive className="size-3" />
                <span>Archived</span>
                <span className="tabular-nums">{archived.length}</span>
              </button>
              {showArchived && (
                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {archived.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      repoPath={repoPath(project.repo_id)}
                      draggable={false}
                      dragging={false}
                      onDragStart={() => {}}
                      onDragEnd={() => {}}
                      onDragOver={() => {}}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Homescreen-only (this component IS the homescreen): the home shell,
          bare on the page ground — no tab strip, no heading (SPEC §11). */}
      {home.open && <HomeTerminalPane term={home.term} onExit={home.onExit} />}

      {profileId !== null && (
        <NewProjectDialog profileId={profileId} open={creating} onOpenChange={setCreating} />
      )}
    </div>
  );
}
