import { useEffect, useMemo, useState } from 'react';
import { CornerDownLeft, Copy, NotebookPen, Pencil, Plus, Trash2 } from 'lucide-react';
import { useParams } from 'react-router';
import { toast } from 'sonner';
import type { ScratchpadEntry } from '@puddle/shared';
import { AgentIcon } from '../../components/agent-icon';
import { Button } from '../../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { registerHotkey } from '../../lib/navigation/hotkeys';
import {
  useAgents,
  useCreateScratchpad,
  useDeleteScratchpad,
  usePatchScratchpad,
  useScratchpad,
} from '../../lib/queries/queries';
import { cn } from '../../lib/utils';
import { useCurrentProfileId } from '../profile/profile-store';
import { ScratchpadEditor, type ScratchpadDraft } from './ScratchpadEditor';
import {
  setScratchpadOpen,
  toggleScratchpad,
  useScratchpadInsertHandler,
  useScratchpadOpen,
} from './scratchpad-store';

/**
 * The Scratchpad (SPEC §11): a top-bar popover between Settings and the
 * profile, floating and scrollable like the profile panel. Entries read as
 * text first — title, then body — with the scope, tags, agent mark, and the
 * always-visible tools on a line BELOW the text, so nothing shifts on hover.
 * Create and edit happen inline in the list (no modal): `+` opens a composer
 * at the top, clicking an entry expands it into the same editor in place.
 */
export function ScratchpadPopover() {
  const open = useScratchpadOpen();
  const profileId = useCurrentProfileId();
  // Inside a project route the popover shows that project's entries too and
  // seeds new entries project-scoped; elsewhere it is profile-wide only.
  const projectId = useParams()['id'];
  const entries = useScratchpad(profileId ?? undefined, projectId).data ?? [];
  const agents = useAgents().data ?? [];
  const create = useCreateScratchpad();
  const patch = usePatchScratchpad();
  const remove = useDeleteScratchpad();
  const onInsert = useScratchpadInsertHandler();

  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [filterAgent, setFilterAgent] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [localOrder, setLocalOrder] = useState<ScratchpadEntry[] | null>(null);

  useEffect(() => registerHotkey('scratchpad.toggle', toggleScratchpad), []);
  // A closed popover drops any in-progress edit/filter state.
  useEffect(() => {
    if (!open) {
      setEditing(null);
      setFilterTag(null);
      setFilterAgent(null);
    }
  }, [open]);

  const allTags = useMemo(
    () => [...new Set(entries.flatMap((e) => e.tags))].sort((a, b) => a.localeCompare(b)),
    [entries],
  );
  const allAgents = useMemo(
    () => [...new Set(entries.map((e) => e.agent_type).filter((a): a is string => a !== null))],
    [entries],
  );
  const filterActive = filterTag !== null || filterAgent !== null;
  const visible = entries.filter(
    (e) =>
      (filterTag === null || e.tags.includes(filterTag)) &&
      (filterAgent === null || e.agent_type === filterAgent),
  );
  // Reordering operates on the full list only (ambiguous under a filter).
  const rows = filterActive ? visible : (localOrder ?? entries);

  const saveNew = (draft: ScratchpadDraft) => {
    if (!profileId) return;
    create.mutate({
      profile_id: profileId,
      scope: draft.scope,
      project_id: draft.scope === 'project' ? projectId : undefined,
      title: draft.title ?? undefined,
      body: draft.body,
      tags: draft.tags,
      agent_type: draft.agent_type ?? undefined,
    });
    setEditing(null);
  };

  const saveEdit = (id: number, draft: ScratchpadDraft) => {
    patch.mutate({
      id,
      scope: draft.scope,
      project_id: draft.scope === 'project' ? (projectId ?? null) : null,
      title: draft.title,
      body: draft.body,
      tags: draft.tags,
      agent_type: draft.agent_type,
    });
    setEditing(null);
  };

  const moveLocal = (dragId: number, overId: number) => {
    const base = localOrder ?? entries;
    const from = base.findIndex((e) => e.id === dragId);
    const to = base.findIndex((e) => e.id === overId);
    if (from === -1 || to === -1 || from === to) return;
    const next = base.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    setLocalOrder(next);
  };

  const commitReorder = () => {
    const id = dragging;
    const order = localOrder;
    setDragging(null);
    setLocalOrder(null);
    if (id === null || !order) return; // released without moving
    const i = order.findIndex((e) => e.id === id);
    if (i === -1) return;
    const prev = order[i - 1];
    const next = order[i + 1];
    // Fractional midpoint of the new neighbours (smaller = top); ends step by 1.
    const position = !prev
      ? (next ? next.position : 0) - 1
      : !next
        ? prev.position + 1
        : (prev.position + next.position) / 2;
    patch.mutate({ id, position });
  };

  const copy = (entry: ScratchpadEntry) => {
    void navigator.clipboard?.writeText(entry.body);
    toast.success('Copied to clipboard');
  };

  return (
    <Popover open={open} onOpenChange={setScratchpadOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {/* compact: narrower box, so the top-bar cluster closes up (§12). */}
            <Button variant="ghost" size="icon" className="compact:h-7 compact:w-7">
              <NotebookPen />
              <span className="sr-only">Scratchpad</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Scratchpad</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-[34rem] max-w-[calc(100vw-1rem)] p-0">
        <div className="flex items-center gap-2 px-5 pb-2 pt-4">
          <span className="text-2xs font-medium uppercase tracking-wide text-fg-gold">
            Scratchpad
          </span>
          <button
            type="button"
            onClick={() => setEditing(editing === 'new' ? null : 'new')}
            className="ml-auto flex items-center rounded-md p-1 text-fg-gold transition-colors hover:bg-surface hover:text-fg"
          >
            <Plus className="size-4" />
            <span className="sr-only">New entry</span>
          </button>
        </div>

        {(allTags.length > 0 || allAgents.length > 0) && (
          <div className="flex flex-wrap items-center gap-1 px-5 pb-2">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setFilterTag((cur) => (cur === tag ? null : tag))}
                className={cn(
                  'rounded-full px-2 py-0.5 text-2xs transition-colors',
                  filterTag === tag
                    ? 'bg-action text-action-ink'
                    : 'bg-surface text-fg-secondary hover:text-fg',
                )}
              >
                {tag}
              </button>
            ))}
            {allAgents.map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={filterAgent === a}
                onClick={() => setFilterAgent((cur) => (cur === a ? null : a))}
                className={cn(
                  'rounded-md p-1 transition-colors',
                  filterAgent === a ? 'bg-action text-action-ink' : 'text-fg-gold hover:bg-surface',
                )}
              >
                <AgentIcon type={a} className="size-3.5" />
              </button>
            ))}
          </div>
        )}

        <div className="no-scrollbar max-h-[65vh] overflow-y-auto px-2 pb-3">
          {editing === 'new' && (
            <div className="px-3 py-2">
              <ScratchpadEditor
                defaultScope={projectId ? 'project' : 'profile'}
                allowProject={projectId !== undefined}
                agents={agents}
                onSave={saveNew}
                onCancel={() => setEditing(null)}
              />
            </div>
          )}
          {rows.length === 0 && editing !== 'new' && (
            <p className="px-3 py-3 text-sm text-fg-muted">
              {filterActive
                ? 'Nothing matches this filter.'
                : 'No entries yet — press + to add a reusable prompt or note.'}
            </p>
          )}
          <ul className="flex flex-col">
            {rows.map((entry) =>
              editing === entry.id ? (
                <li key={entry.id} className="px-3 py-2">
                  <ScratchpadEditor
                    initial={entry}
                    defaultScope={entry.scope}
                    allowProject={projectId !== undefined || entry.scope === 'project'}
                    agents={agents}
                    onSave={(draft) => saveEdit(entry.id, draft)}
                    onCancel={() => setEditing(null)}
                  />
                </li>
              ) : (
                <li
                  key={entry.id}
                  draggable={!filterActive && editing === null}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    setDragging(entry.id);
                  }}
                  onDragOver={(e) => {
                    if (dragging === null) return;
                    e.preventDefault();
                    if (dragging !== entry.id) moveLocal(dragging, entry.id);
                  }}
                  onDragEnd={commitReorder}
                  className={cn('transition-opacity', dragging === entry.id && 'opacity-50')}
                >
                  <ScratchpadRow
                    entry={entry}
                    onInsert={
                      onInsert
                        ? () => {
                            onInsert(entry.body);
                            setScratchpadOpen(false);
                          }
                        : null
                    }
                    onCopy={() => copy(entry)}
                    onEdit={() => setEditing(entry.id)}
                    onDelete={() => remove.mutate(entry.id)}
                  />
                </li>
              ),
            )}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One entry, text first: title, readable body preview, then a persistent
 * meta+tools line — scope, agent, tags on the left, the actions on the right.
 * Always visible, so hovering never reflows the list.
 */
function ScratchpadRow({
  entry,
  onInsert,
  onCopy,
  onEdit,
  onDelete,
}: {
  entry: ScratchpadEntry;
  /** null while no workspace is mounted (nothing to insert into). */
  onInsert: (() => void) | null;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        onEdit();
      }}
      className="cursor-pointer rounded-md px-3 py-2.5 transition-colors hover:bg-surface"
    >
      {entry.title && <p className="text-sm font-medium text-fg">{entry.title}</p>}
      <p
        className={cn(
          'line-clamp-3 whitespace-pre-wrap text-sm text-fg-secondary',
          entry.title && 'mt-0.5',
        )}
      >
        {entry.body}
      </p>

      {confirming ? (
        <div className="mt-2 flex items-center gap-3">
          <span className="text-2xs text-fg-muted">Delete this entry? This can’t be undone.</span>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              onDelete();
            }}
            className="text-2xs font-medium text-interrupted transition-colors hover:underline"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="text-2xs text-fg-muted transition-colors hover:text-fg"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-2xs uppercase tracking-wide text-fg-muted">
            {entry.scope === 'profile' ? 'Profile-wide' : 'Project'}
          </span>
          {entry.agent_type && (
            <AgentIcon type={entry.agent_type} className="size-3 text-fg-gold" />
          )}
          {entry.tags.map((tag) => (
            <span key={tag} className="rounded-full bg-surface px-1.5 text-2xs text-fg-secondary">
              {tag}
            </span>
          ))}
          <div className="ml-auto flex items-center gap-1">
            {onInsert && (
              <RowAction
                icon={CornerDownLeft}
                label="Insert into focused terminal"
                onClick={onInsert}
              />
            )}
            <RowAction icon={Copy} label="Copy" onClick={onCopy} />
            <RowAction icon={Pencil} label="Edit" onClick={onEdit} />
            <RowAction icon={Trash2} label="Delete" onClick={() => setConfirming(true)} />
          </div>
        </div>
      )}
    </div>
  );
}

function RowAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="rounded-md p-1 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
        >
          <Icon className="size-3.5" />
          <span className="sr-only">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
