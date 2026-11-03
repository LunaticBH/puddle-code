import { type DragEvent, useState } from 'react';
import { Link } from 'react-router';
import { ArchiveRestore, Archive as ArchiveIcon, Pencil } from 'lucide-react';
import { toastError } from '../../lib/transport/errors';
import type { Project, ProjectColour } from '@puddle/shared';
import { ColourPicker } from '../../components/colour-picker';
import { appearanceColourClass } from '../../lib/appearance/appearance-colours';
import { projectColourSupported } from '../../lib/transport/protocol-support';
import { Button } from '../../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { ABBREV_MAX, normaliseAbbrev, projectAbbrev } from '../../lib/project-abbrev';
import { useDaemonVersion, usePatchProject, useSessions } from '../../lib/queries/queries';
import { cn } from '../../lib/utils';

import { ProjectCardContent, projectCardSurface } from './ProjectCardContent';

/** A borderless icon button revealed on card hover (HUMANS.md: fill-shift, no border). */
function CardIconButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Pencil;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className="flex items-center rounded-md p-1.5 text-fg-muted transition-colors hover:bg-ground hover:text-fg"
    >
      <Icon className="size-4" />
    </button>
  );
}

/**
 * One homescreen project card: click to open, drag to reorder, hover reveals
 * edit/archive in the bottom-right, and right-click opens the same actions.
 * Archive is a reversible hide (all data retained); archived cards offer
 * "Reopen" instead (SPEC §11).
 */
export function ProjectCard({
  project,
  repoPath,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
  onDragOver,
}: {
  project: Project;
  repoPath: string | undefined;
  draggable: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
}) {
  const patch = usePatchProject();
  const colourSupported = projectColourSupported(useDaemonVersion().data?.protocol);
  const sessions = useSessions(project.id);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  const [abbrev, setAbbrev] = useState(projectAbbrev(project));
  const [colour, setColour] = useState<ProjectColour | null>(project.colour ?? null);

  const archive = (archived: boolean) =>
    patch.mutate({ id: project.id, archived }, { onError: (e) => toastError(e) });

  const openEdit = () => {
    setName(project.name);
    setColour(project.colour ?? null);
    // Prefilled with the label the rail actually shows (stored or derived) —
    // never an empty field that means something else.
    setAbbrev(projectAbbrev(project));
    setRenaming(true);
  };

  const submitRename = () => {
    const trimmed = name.trim();
    const nextAbbrev = normaliseAbbrev(abbrev);
    if (!trimmed) {
      setRenaming(false);
      return;
    }
    const patchBody = {
      ...(trimmed !== project.name ? { name: trimmed } : {}),
      ...(nextAbbrev && nextAbbrev !== projectAbbrev(project) ? { abbrev: nextAbbrev } : {}),
      ...(colourSupported && colour !== (project.colour ?? null) ? { colour } : {}),
    };
    if (Object.keys(patchBody).length === 0) {
      setRenaming(false);
      return;
    }
    patch.mutate(
      { id: project.id, ...patchBody },
      { onSuccess: () => setRenaming(false), onError: (e) => toastError(e) },
    );
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            draggable={draggable}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragOver={onDragOver}
            className={cn('group relative transition-opacity', dragging && 'opacity-50')}
          >
            <Link draggable={false} to={`/project/${project.id}`} className={projectCardSurface}>
              <ProjectCardContent
                project={project}
                repoPath={repoPath}
                sessions={sessions.data ?? []}
              />
            </Link>
            {/* Actions sit over the card's top-right, revealed on hover; siblings
                of the Link so a click never navigates. */}
            <div className="absolute right-2 top-2 hidden gap-0.5 group-hover:flex has-[[data-state=open]]:flex pointer-coarse:flex">
              {project.archived ? (
                <CardIconButton
                  icon={ArchiveRestore}
                  label="Reopen project"
                  onClick={() => archive(false)}
                />
              ) : (
                <>
                  <CardIconButton icon={Pencil} label="Edit project" onClick={openEdit} />
                  <CardIconButton
                    icon={ArchiveIcon}
                    label="Archive project"
                    onClick={() => archive(true)}
                  />
                </>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {project.archived ? (
            <ContextMenuItem onSelect={() => archive(false)}>
              <ArchiveRestore /> Reopen
            </ContextMenuItem>
          ) : (
            <>
              <ContextMenuItem onSelect={openEdit}>
                <Pencil /> Edit
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => archive(true)}>
                <ArchiveIcon /> Archive
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit project</DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              submitRename();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`project-name-${project.id}`}>Name</Label>
              <Input
                id={`project-name-${project.id}`}
                value={name}
                className={appearanceColourClass(colour)}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`project-abbrev-${project.id}`}>Abbreviation</Label>
              <Input
                id={`project-abbrev-${project.id}`}
                maxLength={ABBREV_MAX}
                value={abbrev}
                onChange={(e) => setAbbrev(normaliseAbbrev(e.target.value))}
                className="w-24 uppercase"
              />
              <p className="text-2xs text-fg-muted">
                Up to {ABBREV_MAX} characters — the label on the collapsed sidebar rail.
              </p>
            </div>
            {colourSupported && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-fg-secondary">Colour</span>
                <ColourPicker value={colour} onChange={setColour} label="Project colour" />
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Label className="text-fg-muted">Path</Label>
              <p className="truncate text-2xs text-fg-muted">{repoPath ?? '…'}</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || patch.isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
