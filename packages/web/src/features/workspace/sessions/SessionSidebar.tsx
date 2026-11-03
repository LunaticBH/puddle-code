import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { Link } from 'react-router';
import {
  Archive,
  Bot,
  ChevronRight,
  FolderX,
  GitBranch,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Palette,
  ShieldOff,
  MessageCircleX,
  TriangleAlert,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import type { Account, Project, Session } from '@puddle/shared';
import { ColourPicker } from '../../../components/colour-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { appearanceColourClass } from '../../../lib/appearance/appearance-colours';
import { projectColourSupported } from '../../../lib/transport/protocol-support';
import { AgentIcon } from '../../../components/agent-icon';
import { HoverMarquee } from '../../../components/hover-marquee';
import { InlineLabelEdit } from '../../../components/inline-label-edit';
import { HeightHandle, useResizableHeight } from '../../../components/resizable-height';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  menuOnDoubleClick,
} from '../../../components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { toastError } from '../../../lib/transport/errors';
import { ABBREV_MAX, normaliseAbbrev } from '../../../lib/project-abbrev';
import { useDaemonVersion, usePatchProject } from '../../../lib/queries/queries';
import { useHotkeyLabel } from '../../../lib/navigation/hotkeys';
import { cn } from '../../../lib/utils';
import { relativeTime } from '../../history/history-logic';
import { useSessionTitleRenderer } from '../../profile/use-session-title';
import { SessionGlyph } from '../../status/SessionGlyph';
import {
  SessionActionsEllipsis,
  SessionContextMenu,
  SessionContextMenuBody,
  useSessionMenu,
} from './SessionActions';
import type { SessionSelectionModifiers } from './session-selection';
import {
  decodeSessionDrag,
  encodeSessionDrag,
  hasSessionDrag,
  sessionsForDrag,
  SESSION_DRAG_MIME,
} from './session-selection';
import { moveWithinGroups } from './session-order';
import {
  decodeTabTransfer,
  encodeTabTransfer,
  hasTabTransfer,
  TAB_MIME,
} from '../tabs/tab-transfer';
import { ARCHIVE_DROP_PREFIX, useActiveDragRef } from '../layout/TilingDnd';

/**
 * A project's sessions for the sidebar. Groups are retained even when empty so
 * the project itself remains a navigation target (SPEC §12).
 */
export interface SessionGroup {
  projectId: string;
  name: string;
  /** The collapsed rail's ≤5-char label (stored abbrev, else derived — SPEC §12). */
  abbrev: string;
  colour?: Project['colour'];
  /** The project's repository — seeds the create dialogue for "new … in project". */
  repoId: number;
  sessions: Session[];
}

/** Callbacks every project header carries (context menu + drag reorder). */
export interface ProjectHeaderActions {
  /** Open the new-agent dialogue targeting this project. */
  onNewSessionIn: (projectId: string) => void;
  /** Open the new-terminal dialogue targeting this project. */
  onNewTerminalIn: (projectId: string) => void;
  /** A project-header drag: move `dragId` before `beforeId` in `projectOrder`. */
  onMoveProject: (dragId: string, beforeId: string) => void;
}

/** Selection state shared by the expanded list and collapsed rail. */
export interface SidebarSessionSelection {
  ids: ReadonlySet<string>;
  onSelect: (id: string, modifiers: SessionSelectionModifiers) => void;
  onSelectOnly: (id: string) => void;
  onArchive: (ids: readonly string[]) => void;
}

/**
 * A project-name drag reorders projects; its payload is this private MIME so no
 * pane or list mistakes it for a tab drag (reordering rides dragover, the
 * payload itself is never dropped anywhere).
 */
const PROJECT_MIME = 'application/x-puddle-project';

/** Which hover drives a session row's marquees: the row itself (`group`). */
const ROW_MARQUEE = 'group-hover:[transform:translateX(var(--tail))]';

/** Give a multi-session drag an honest preview instead of showing one row. */
function setCountDragImage(e: DragEvent, count: number) {
  const chip = document.createElement('div');
  chip.textContent = `${count} sessions`;
  chip.className = 'fixed -top-12 left-0 rounded-md bg-elevated px-2 py-1 text-xs text-fg';
  document.body.appendChild(chip);
  e.dataTransfer.setDragImage(chip, 12, 12);
  requestAnimationFrame(() => chip.remove());
}

/**
 * The project header's right-click menu: start a new agent or terminal IN that
 * project — the same create dialogue the sidebar's fixed controls open, seeded
 * with this project instead of the current one — and edit the label the header
 * is showing. `editLabel` names THAT label (the name in the expanded header, the
 * abbreviation on the collapsed rail) and opens the very editor a double-click
 * on it opens, so each menu offers exactly the field under the cursor.
 */
function ProjectMenuBody({
  projectId,
  name,
  colour,
  actions,
  editLabel,
}: {
  projectId: string;
  name: string;
  colour: Project['colour'];
  actions: ProjectHeaderActions;
  editLabel: { label: string; onSelect: () => void };
}) {
  const [choosingColour, setChoosingColour] = useState(false);
  const patch = usePatchProject();
  const colourSupported = projectColourSupported(useDaemonVersion().data?.protocol);
  return (
    <>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => actions.onNewSessionIn(projectId)}>
          <Bot />
          New agent
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onNewTerminalIn(projectId)}>
          <SquareTerminal />
          New terminal
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={editLabel.onSelect}>
          <Pencil />
          {editLabel.label}
        </ContextMenuItem>
        {colourSupported && (
          <ContextMenuItem onSelect={() => setChoosingColour(true)}>
            <Palette />
            Change project colour
          </ContextMenuItem>
        )}
      </ContextMenuContent>
      <Dialog open={choosingColour} onOpenChange={setChoosingColour}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Project colour</DialogTitle>
            <DialogDescription className={appearanceColourClass(colour)}>{name}</DialogDescription>
          </DialogHeader>
          <ColourPicker
            value={colour}
            label="Project colour"
            disabled={patch.isPending}
            onChange={(next) =>
              patch.mutate(
                { id: projectId, colour: next },
                { onSuccess: () => setChoosingColour(false), onError: (e) => toastError(e) },
              )
            }
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Archive-by-drag plumbing (SPEC §12): a session dragged onto an archive
 * target is archived. The sidebar's own rows and rail glyphs ride native HTML5
 * DnD (`TAB_MIME`, plus `SESSION_DRAG_MIME` for a selected batch), while centre
 * tab chips ride dnd-kit (a droppable under the workspace-wide `TilingDnd`
 * context, which routes the release via its `onArchive`). Editor payloads are
 * ignored — only a terminal ref names a session.
 */
function useArchiveDrop(id: string, onArchiveDrop: (sessions: readonly string[]) => void) {
  const { isOver, setNodeRef } = useDroppable({ id: `${ARCHIVE_DROP_PREFIX}${id}` });
  const activeRef = useActiveDragRef();
  const [nativeOver, setNativeOver] = useState(false);
  // A drag that ends anywhere disarms the highlight: released over a pane or
  // cancelled with Esc, no `dragleave`/`drop` of ours fires (see PaneLeaf).
  useEffect(() => {
    const clear = () => setNativeOver(false);
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);
  return {
    setNodeRef,
    /** Arm the highlight for either payload path. */
    armed: nativeOver || (isOver && activeRef?.type === 'terminal'),
    props: {
      onDragOver: (e: DragEvent) => {
        if (!hasSessionDrag(e.dataTransfer.types) && !hasTabTransfer(e.dataTransfer.types)) return;
        e.preventDefault();
        setNativeOver(true);
      },
      onDragLeave: () => setNativeOver(false),
      onDrop: (e: DragEvent) => {
        setNativeOver(false);
        const sessions = decodeSessionDrag(e.dataTransfer.getData(SESSION_DRAG_MIME));
        if (sessions.length > 0) {
          e.preventDefault();
          onArchiveDrop(sessions);
          return;
        }
        const ref = decodeTabTransfer(e.dataTransfer.getData(TAB_MIME));
        if (ref?.type !== 'terminal') return;
        e.preventDefault();
        onArchiveDrop([ref.session]);
      },
    },
  };
}

/** The collapsed rail's archive target: an icon at the rail's foot. */
function RailArchiveTarget({
  onArchiveDrop,
  onExpand,
}: {
  onArchiveDrop: (sessions: readonly string[]) => void;
  onExpand: () => void;
}) {
  const drop = useArchiveDrop('rail', onArchiveDrop);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={drop.setNodeRef}
          type="button"
          onClick={onExpand}
          {...drop.props}
          className={cn(
            'mt-1 flex shrink-0 items-center rounded-md p-1.5 text-fg-muted transition-colors hover:bg-elevated hover:text-fg compact:p-1',
            drop.armed && 'bg-selection text-fg',
          )}
        >
          <Archive className="size-4" />
          <span className="sr-only">Archived sessions</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">Drop selected sessions here to archive them</TooltipContent>
    </Tooltip>
  );
}

/**
 * While any project name is being dragged, every group's session list collapses
 * (0fr grid row) so the list reads as just the project names — the dragged name
 * repositions against its neighbours, exactly like a homescreen card.
 */
function CollapsibleSessions({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200',
        collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
      )}
    >
      {children}
    </div>
  );
}

/**
 * A borderless icon button with a fill-shift hover (mirrors the left navigator).
 * `active` marks a toggled-on state with the same `bg-elevated` fill the nav
 * mode icons use (for the Scratchpad view toggle).
 */
function IconButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  // Downwards by default: these buttons head a sidebar, so this is the topmost
  // row under the title bar and an upward tooltip covered the macOS traffic
  // lights (the left navigator's icon row does the same).
  tooltipSide = 'bottom',
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  /** The collapsed rail opens its tooltips inward (left), like the left rail. */
  tooltipSide?: 'left' | 'bottom';
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-pressed={active}
          className={cn(
            'flex items-center rounded-md p-1.5 transition-colors',
            active ? 'bg-elevated text-fg' : 'text-fg-gold hover:bg-elevated hover:text-fg',
          )}
        >
          <Icon className="size-4" />
          <span className="sr-only">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Name over branch over agent · account — the tooltip for a collapsed dot. */
function SessionLabel({ session, accountLabel }: { session: Session; accountLabel?: string }) {
  const renderTitle = useSessionTitleRenderer();
  return (
    <span className="flex flex-col">
      <span>{renderTitle(session)}</span>
      <span className="text-2xs text-fg-muted">{session.branch}</span>
      <span className="mt-0.5 flex items-center gap-1 text-2xs text-fg-muted">
        {session.kind === 'terminal' ? (
          <>
            {session.detected_agent_type ? (
              <AgentIcon type={session.detected_agent_type} className="size-3 shrink-0" />
            ) : (
              <SquareTerminal className="size-3 shrink-0" />
            )}
            <span>
              {session.detected_agent_type
                ? `${session.detected_agent_type} · terminal`
                : 'terminal'}
            </span>
          </>
        ) : (
          <>
            <AgentIcon type={session.agent_type ?? ''} className="size-3 shrink-0" />
            <span>{session.agent_type}</span>
            {accountLabel && <span> · {accountLabel}</span>}
          </>
        )}
      </span>
    </span>
  );
}

/**
 * One collapsed-rail status glyph: navigates on click (to its own project, so the
 * cross-project rail switches projects too) and right-clicking opens the same
 * lifecycle menu as the expanded row's ellipsis. The context-menu and tooltip
 * triggers both wrap the single `<Link>` (stacked `asChild`).
 */
function CollapsedSessionDot({
  session,
  accountLabel,
  activeSessionId,
  onPromote,
  onArchived,
  selectedIds,
  selection,
}: {
  session: Session;
  accountLabel?: string;
  activeSessionId: string | null;
  onPromote: (id: string) => void;
  onArchived: (id: string) => void;
  selectedIds: readonly string[];
  selection: SidebarSessionSelection;
}) {
  const { menu, dialogs } = useSessionMenu(session, onArchived);
  const renderTitle = useSessionTitleRenderer();
  const selected = selection.ids.has(session.id);
  const batch =
    selected && selectedIds.length > 1
      ? { sessionIds: selectedIds, archiveAll: selection.onArchive }
      : undefined;
  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <Link
              draggable={false}
              aria-current={session.id === activeSessionId ? 'true' : undefined}
              // Single click opens the session's terminal as a preview tab
              // (via navigation); double click pins it, like a file's tab.
              onClick={(e) => {
                const modified = e.shiftKey || e.metaKey || e.ctrlKey;
                selection.onSelect(session.id, {
                  shift: e.shiftKey,
                  toggle: e.metaKey || e.ctrlKey,
                });
                if (modified) e.preventDefault();
              }}
              onDoubleClick={() => onPromote(session.id)}
              onContextMenu={() => {
                if (!selected) selection.onSelectOnly(session.id);
              }}
              to={`/project/${session.project_id}/session/${session.id}`}
              aria-selected={selected}
              className={cn(
                'flex items-center rounded-md p-1 transition-colors hover:bg-elevated',
                selected ? 'bg-selection' : session.id === activeSessionId && 'bg-elevated',
              )}
            >
              {/* Active session marked with the same bg-elevated fill-shift the
                  expanded list and the navigator's mode icons use — a theme
                  colour, no border, no default-blue ring (HUMANS.md). Sizing
                  settled by eye against the live rail (2026-08-06, three
                  rounds): 16px marks comfortable / 12px compact at 0.75×
                  stroke — the mark full-bleeds its box rather than floating a
                  12px icon in a 16px one, which is what made the marks swim in
                  their chips. */}
              <SessionGlyph
                status={session.status}
                kind={session.kind}
                agentType={session.agent_type}
                detectedAgentType={session.detected_agent_type}
                stale={session.stale_running}
                className="size-4 compact:size-3"
                iconClassName="size-full"
                iconStrokeScale={0.75}
              />
              <span className="sr-only">{renderTitle(session)}</span>
            </Link>
          </TooltipTrigger>
        </ContextMenuTrigger>
        {/* To the left, into the workspace — a tooltip above the glyph would sit
            on the glyphs before it in the rail. */}
        <TooltipContent side="left">
          <SessionLabel session={session} accountLabel={accountLabel} />
        </TooltipContent>
      </Tooltip>
      <SessionContextMenuBody menu={menu} batch={batch} />
      {dialogs}
    </ContextMenu>
  );
}

/**
 * The collapsed right sidebar: a slim rail whose expand / new-terminal /
 * new-session controls stay fixed at the top, then one clickable agent or
 * terminal glyph per live session — grouped by project with a divider and
 * compact project label between groups (SPEC §12). The glyphs scroll (no
 * visible scrollbar) so a long list still works.
 */
export function CollapsedSessionsRail({
  groups,
  accounts,
  activeSessionId,
  onReorder,
  onPromote,
  onExpand,
  onNewTerminal,
  onNewSession,
  onArchived,
  onArchiveDrop,
  selection,
  projectActions,
}: {
  groups: SessionGroup[];
  accounts: Account[];
  activeSessionId: string | null;
  onReorder: (ids: string[]) => void;
  /** Double-click: pin the session's (preview) terminal tab. */
  onPromote: (id: string) => void;
  onExpand: () => void;
  onNewTerminal: () => void;
  onNewSession: () => void;
  onArchived: (id: string) => void;
  /** A session dropped on the rail's archive icon: archive it (SPEC §12). */
  onArchiveDrop: (sessions: readonly string[]) => void;
  selection: SidebarSessionSelection;
  projectActions: ProjectHeaderActions;
}) {
  const [dragging, setDragging] = useState<{
    sourceId: string;
    sessionIds: readonly string[];
  } | null>(null);
  const [dragProject, setDragProject] = useState<string | null>(null);
  const [editingAbbrev, setEditingAbbrev] = useState<string | null>(null);
  const patchProject = usePatchProject();
  const accountLabel = new Map(accounts.map((a) => [a.id, a.label]));
  const visibleIds = useMemo(
    () => groups.flatMap((group) => group.sessions.map((session) => session.id)),
    [groups],
  );
  const selectedIds = visibleIds.filter((id) => selection.ids.has(id));
  const move = (id: string, before: string) => {
    const next = moveWithinGroups(groups, id, before);
    if (next) onReorder(next);
  };
  const commitAbbrev = (group: SessionGroup, value: string) => {
    setEditingAbbrev(null);
    const next = normaliseAbbrev(value);
    if (!next || next === group.abbrev) return;
    patchProject.mutate({ id: group.projectId, abbrev: next }, { onError: (e) => toastError(e) });
  };
  return (
    <div className="flex h-full min-h-0 w-9 shrink-0 flex-col items-center overflow-hidden bg-surface py-1.5 compact:py-1">
      <div className="flex flex-col items-center gap-1 compact:gap-0.5">
        <IconButton
          icon={PanelRightOpen}
          label="Show sessions"
          onClick={onExpand}
          tooltipSide="left"
        />
        <IconButton icon={Bot} label="New agent" onClick={onNewSession} tooltipSide="left" />
        <IconButton
          icon={SquareTerminal}
          label="New terminal"
          onClick={onNewTerminal}
          tooltipSide="left"
        />
      </div>
      <div className="no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overscroll-contain compact:gap-0.5">
        {groups.map((group) => (
          // A divider precedes every group (the first one separates glyphs
          // from the controls above; the rest separate projects).
          <div
            key={group.projectId}
            className="flex flex-col items-center gap-1 compact:gap-0.5"
            onDragOver={(e) => {
              if (!dragProject) return;
              e.preventDefault();
              if (dragProject !== group.projectId)
                projectActions.onMoveProject(dragProject, group.projectId);
            }}
          >
            <div className="my-0.5 h-px w-7 shrink-0 bg-border" />
            {/* Both triggers stack over the single <Link> (as the dots do): the
                tooltip shows the FULL project name the abbreviation stands for;
                right-click opens the new-agent/terminal menu; the label drags
                to reorder projects. A single click navigates (any project); a
                DOUBLE-click opens that same menu (decision 2026-08-05 — it used
                to go straight into the abbreviation editor, which picks one of
                the menu's actions on the user's behalf; Change project
                abbreviation is still one click away inside it). */}
            {editingAbbrev === group.projectId ? (
              <InlineLabelEdit
                initial={group.abbrev}
                maxLength={ABBREV_MAX}
                className="w-7 text-center text-[8px] uppercase leading-3 text-fg"
                onCommit={(v) => commitAbbrev(group, v)}
                onCancel={() => setEditingAbbrev(null)}
              />
            ) : (
              <ContextMenu>
                <Tooltip>
                  <ContextMenuTrigger asChild>
                    <TooltipTrigger asChild>
                      <Link
                        to={`/project/${group.projectId}`}
                        {...menuOnDoubleClick()}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(PROJECT_MIME, group.projectId);
                          setDragProject(group.projectId);
                        }}
                        onDragEnd={() => setDragProject(null)}
                        className={cn(
                          'w-7 truncate text-center text-[8px] uppercase leading-3 transition-colors',
                          appearanceColourClass(group.colour)
                            ? cn(appearanceColourClass(group.colour), 'hover:opacity-75')
                            : 'text-fg-muted hover:text-fg',
                          dragProject === group.projectId && 'opacity-50',
                        )}
                      >
                        {group.abbrev}
                      </Link>
                    </TooltipTrigger>
                  </ContextMenuTrigger>
                  <TooltipContent side="left">{group.name}</TooltipContent>
                </Tooltip>
                <ProjectMenuBody
                  projectId={group.projectId}
                  name={group.name}
                  colour={group.colour}
                  actions={projectActions}
                  editLabel={{
                    label: 'Change project abbreviation',
                    onSelect: () => setEditingAbbrev(group.projectId),
                  }}
                />
              </ContextMenu>
            )}
            <CollapsibleSessions collapsed={dragProject !== null}>
              <div className="flex flex-col items-center gap-1 overflow-hidden compact:gap-0.5">
                {group.sessions.map((session) => (
                  <div
                    key={session.id}
                    draggable
                    onDragStart={(e) => {
                      const sessionIds = sessionsForDrag(visibleIds, selection.ids, session.id);
                      // The same drag reorders within the rail AND, dropped on a
                      // tiling pane, opens the grabbed session there as a
                      // permanent tab. The companion payload lets the archive
                      // target act on the whole selection.
                      e.dataTransfer.setData(
                        TAB_MIME,
                        encodeTabTransfer({ type: 'terminal', session: session.id }),
                      );
                      e.dataTransfer.setData(SESSION_DRAG_MIME, encodeSessionDrag(sessionIds));
                      e.dataTransfer.effectAllowed = 'copyMove';
                      if (sessionIds.length > 1) setCountDragImage(e, sessionIds.length);
                      if (!selection.ids.has(session.id)) selection.onSelectOnly(session.id);
                      setDragging({ sourceId: session.id, sessionIds });
                    }}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragging?.sessionIds.length === 1 && dragging.sourceId !== session.id)
                        move(dragging.sourceId, session.id);
                    }}
                    className={cn(
                      'transition-opacity',
                      dragging?.sessionIds.includes(session.id) && 'opacity-50',
                    )}
                  >
                    <CollapsedSessionDot
                      session={session}
                      accountLabel={
                        session.account_id === null
                          ? undefined
                          : accountLabel.get(session.account_id)
                      }
                      activeSessionId={activeSessionId}
                      onPromote={onPromote}
                      onArchived={onArchived}
                      selectedIds={selectedIds}
                      selection={selection}
                    />
                  </div>
                ))}
              </div>
            </CollapsibleSessions>
          </div>
        ))}
      </div>
      {/* The rail's foot: sessions dragged here — glyphs above or centre tab
          chips — archive; a click expands the sidebar to the full list. */}
      <RailArchiveTarget onArchiveDrop={onArchiveDrop} onExpand={onExpand} />
    </div>
  );
}

/** One expanded-sidebar row: display-name title over branch/account lines. */
function SessionRow({
  session,
  activeSessionId,
  accountLabel,
  onPromote,
  onArchived,
  selectedIds,
  selection,
  ellipsis,
  lastActive = false,
}: {
  session: Session;
  activeSessionId: string | null;
  accountLabel: Map<number, string>;
  /** Double-click: pin the session's (preview) terminal tab. */
  onPromote?: (id: string) => void;
  onArchived: (id: string) => void;
  selectedIds?: readonly string[];
  selection?: SidebarSessionSelection;
  /** Whether to mount the hover ellipsis (archived rows omit it). */
  ellipsis: boolean;
  /**
   * Show when the session was last active instead of its agent · account line —
   * for archived rows, where "how long ago did I stop working on this" is the
   * only thing that orders a long list (nothing is running to have a status).
   */
  lastActive?: boolean;
}) {
  const renderTitle = useSessionTitleRenderer();
  const selected = selection?.ids.has(session.id) ?? false;
  const batch =
    selection && selected && selectedIds && selectedIds.length > 1
      ? { sessionIds: selectedIds, archiveAll: selection.onArchive }
      : undefined;
  const kindLabel = session.kind === 'terminal' ? 'terminal' : (session.agent_type ?? 'agent');
  // An archived row trades its account for its last activity — the account is
  // fixed for the session's life and interesting while it runs; once archived,
  // when you last touched it is what tells the list apart.
  const suffix = lastActive
    ? session.last_activity_at === null
      ? ''
      : ` · ${relativeTime(session.last_activity_at)}`
    : session.account_id !== null && accountLabel.has(session.account_id)
      ? ` · ${accountLabel.get(session.account_id)}`
      : '';
  return (
    <SessionContextMenu session={session} onArchived={onArchived} batch={batch}>
      {(menu) => (
        <Link
          // draggable=false: let the <li> own the drag (reorder), not the
          // anchor's native "drag the URL" behaviour. Click still navigates — to
          // its own project, so the cross-project list switches projects too.
          draggable={false}
          // Single click = preview terminal (via navigation); double click
          // pins it, matching the file tree's single/double-click semantics.
          onClick={(e) => {
            if (!selection) return;
            const modified = e.shiftKey || e.metaKey || e.ctrlKey;
            selection.onSelect(session.id, {
              shift: e.shiftKey,
              toggle: e.metaKey || e.ctrlKey,
            });
            if (modified) e.preventDefault();
          }}
          onDoubleClick={onPromote && (() => onPromote(session.id))}
          onContextMenu={() => {
            if (selection && !selected) selection.onSelectOnly(session.id);
          }}
          to={`/project/${session.project_id}/session/${session.id}`}
          aria-selected={selection ? selected : undefined}
          className={cn(
            'group flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-elevated compact:gap-1.5 compact:py-1',
            selected ? 'bg-selection' : session.id === activeSessionId && 'bg-elevated',
          )}
        >
          <SessionGlyph
            status={session.status}
            kind={session.kind}
            agentType={session.agent_type}
            detectedAgentType={session.detected_agent_type}
            stale={session.stale_running}
          />
          {/* All three lines ease leftwards on the row's hover, at the app's one
              marquee speed — an agent names its own sessions, so the title is
              the label most likely to be clipped, and it is exactly the one you
              hover the row to read. */}
          <span className="min-w-0 flex-1">
            <HoverMarquee
              text={renderTitle(session)}
              className="font-sans text-xs text-fg"
              hoverClass={ROW_MARQUEE}
            />
            <span className="flex items-center gap-1 text-2xs text-fg-muted">
              <GitBranch className="size-3 shrink-0 text-fg-gold" />
              <HoverMarquee text={session.branch} hoverClass={ROW_MARQUEE} />
            </span>
            <span className="flex items-center gap-1 text-2xs text-fg-muted">
              <HoverMarquee text={`${kindLabel}${suffix}`} hoverClass={ROW_MARQUEE} />
            </span>
          </span>
          {session.skip_permissions && (
            <Tooltip>
              <TooltipTrigger asChild>
                <ShieldOff className="size-3.5 shrink-0 text-warning" />
              </TooltipTrigger>
              <TooltipContent>Running with permission prompts skipped</TooltipContent>
            </Tooltip>
          )}
          {session.worktree_missing && (
            <Tooltip>
              <TooltipTrigger asChild>
                <FolderX className="size-3.5 shrink-0 text-interrupted" />
              </TooltipTrigger>
              <TooltipContent>Worktree directory is gone — archive only</TooltipContent>
            </Tooltip>
          )}
          {session.conversation_missing && (
            <Tooltip>
              <TooltipTrigger asChild>
                <MessageCircleX className="size-3.5 shrink-0 text-interrupted" />
              </TooltipTrigger>
              <TooltipContent>Native conversation is missing — resume unavailable</TooltipContent>
            </Tooltip>
          )}
          {session.native_sync === 'fallback' && session.status !== 'archived' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <TriangleAlert className="size-3.5 shrink-0 text-fg-muted" />
              </TooltipTrigger>
              <TooltipContent>In-agent conversation switches are not synchronised</TooltipContent>
            </Tooltip>
          )}
          {/* Reserves no width until hover, so the title/branch/badges fill the
              row's whole width; on hover it appears and shoves them left. Stays
              shown while its menu is open even if the pointer has left the row. */}
          {ellipsis && (
            <span className="hidden group-hover:inline-flex has-[[data-state=open]]:inline-flex pointer-coarse:inline-flex">
              <SessionActionsEllipsis menu={menu} />
            </span>
          )}
        </Link>
      )}
    </SessionContextMenu>
  );
}

/**
 * Session list: a display-font title over the mono branch (git-branch icon) and
 * account (agent-brand icon) lines, live status glyphs, badges, lifecycle menu.
 * Sessions are grouped by project (a header per project in the cross-project
 * view); the list scrolls with no visible scrollbar while the controls stay
 * fixed. Archived sessions are not deleted — they collapse into a disclosure at
 * the bottom so they stay reachable (SPEC §4, §12).
 */
export function SessionSidebar({
  groups,
  accounts,
  activeSessionId,
  onReorder,
  onPromote,
  archived,
  onNewSession,
  onNewTerminal,
  onCollapse,
  onArchived,
  onArchiveDrop,
  selection,
  projectActions,
}: {
  groups: SessionGroup[];
  accounts: Account[];
  activeSessionId: string | null;
  /** Rows drag-reorder within their project group; `ids` is the full visible order. */
  onReorder: (ids: string[]) => void;
  /** Double-click: pin the session's (preview) terminal tab. */
  onPromote: (id: string) => void;
  /** Current project's archived sessions. */
  archived: Session[];
  onNewSession: () => void;
  onNewTerminal: () => void;
  onCollapse: () => void;
  onArchived: (id: string) => void;
  /** A session dropped on the Archived header: archive it (SPEC §12). */
  onArchiveDrop: (sessions: readonly string[]) => void;
  selection: SidebarSessionSelection;
  projectActions: ProjectHeaderActions;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      {/* Fixed controls: collapse on the left edge; the Agent · Terminal
          symbols on the right (SPEC §8) — the Scratchpad lives in the top bar
          (SPEC §11), not here. */}
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <IconButton icon={PanelRightClose} label="Hide sessions" onClick={onCollapse} />
        <div className="ml-auto flex items-center gap-1">
          <IconButton icon={Bot} label="New agent" onClick={onNewSession} />
          <IconButton icon={SquareTerminal} label="New terminal" onClick={onNewTerminal} />
        </div>
      </div>
      <SessionListBody
        groups={groups}
        accounts={accounts}
        activeSessionId={activeSessionId}
        onReorder={onReorder}
        onPromote={onPromote}
        archived={archived}
        onArchived={onArchived}
        onArchiveDrop={onArchiveDrop}
        selection={selection}
        projectActions={projectActions}
      />
    </div>
  );
}

/** The session-list body (extracted so the sidebar shell can swap in Scratchpad). */
function SessionListBody({
  groups,
  accounts,
  activeSessionId,
  onReorder,
  onPromote,
  archived,
  onArchived,
  onArchiveDrop,
  selection,
  projectActions,
}: {
  groups: SessionGroup[];
  accounts: Account[];
  activeSessionId: string | null;
  onReorder: (ids: string[]) => void;
  onPromote: (id: string) => void;
  archived: Session[];
  onArchived: (id: string) => void;
  onArchiveDrop: (sessions: readonly string[]) => void;
  selection: SidebarSessionSelection;
  projectActions: ProjectHeaderActions;
}) {
  const [dragging, setDragging] = useState<{
    sourceId: string;
    sessionIds: readonly string[];
  } | null>(null);
  const [dragProject, setDragProject] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // The Archived header doubles as the archive drop target; while a session
  // drags (a row here, or a centre tab chip) it appears even with nothing
  // archived yet, so there is always somewhere to drop.
  const archiveDrop = useArchiveDrop('list', onArchiveDrop);
  const activeDragRef = useActiveDragRef();
  const sessionDragActive = dragging !== null || activeDragRef?.type === 'terminal';
  const patchProject = usePatchProject();
  const paletteKey = useHotkeyLabel('palette.toggle');
  const accountLabel = new Map(accounts.map((a) => [a.id, a.label]));
  const total = groups.reduce((n, g) => n + g.sessions.length, 0);
  const visibleIds = useMemo(
    () => groups.flatMap((group) => group.sessions.map((session) => session.id)),
    [groups],
  );
  const selectedIds = visibleIds.filter((id) => selection.ids.has(id));
  // The open archived pane's height, dragged by the border above its header.
  const { height: archivedHeight, handle } = useResizableHeight('sessions-archived', 200, {
    sized: 'below',
    min: 96,
  });
  // Archived sessions grouped like the live ones (SPEC §12), in the same project
  // order — a flat list of every project's archives was unreadable once more
  // than one project had any. A session whose project has no group (an archived
  // project) still lists, under no header, rather than disappearing.
  const archivedGroups = useMemo<SessionGroup[]>(() => {
    const placed = new Set<string>();
    const byProject = groups.map((g) => {
      const rows = archived.filter((s) => s.project_id === g.projectId);
      for (const s of rows) placed.add(s.id);
      return { ...g, sessions: rows };
    });
    const orphans = archived.filter((s) => !placed.has(s.id));
    return [
      ...byProject.filter((g) => g.sessions.length > 0),
      ...(orphans.length > 0
        ? [{ projectId: '', name: '', abbrev: '', colour: null, repoId: -1, sessions: orphans }]
        : []),
    ];
  }, [groups, archived]);

  const move = (id: string, before: string) => {
    const next = moveWithinGroups(groups, id, before);
    if (next) onReorder(next);
  };
  const commitName = (group: SessionGroup, value: string) => {
    setEditingName(null);
    const next = value.trim();
    if (!next || next === group.name) return;
    patchProject.mutate({ id: group.projectId, name: next }, { onError: (e) => toastError(e) });
  };

  return (
    <>
      {/* body */}
      {/* No horizontal padding: the active/hover fill-shift bleeds to both
          sidebar edges (each row carries its own px-3). Scrolls without a
          visible scrollbar so a long cross-project list still works. */}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain py-1.5">
        {total === 0 && archived.length === 0 && (
          <p className="px-3 py-3 text-xs text-fg-muted">
            No sessions yet — press {paletteKey} to start one.
          </p>
        )}
        {groups.map((group) => (
          <div
            key={group.projectId}
            onDragOver={(e) => {
              if (!dragProject) return;
              e.preventDefault();
              if (dragProject !== group.projectId)
                projectActions.onMoveProject(dragProject, group.projectId);
            }}
          >
            {/* The header right-clicks into the new-agent/terminal menu and
                drags to reorder projects (the same projectOrder the homescreen
                cards persist); while any header drags, the session lists
                collapse so only the names reposition. A single click navigates
                (any project); a DOUBLE-click opens the same menu, where Change
                project name sits among the other actions (decision
                2026-08-05 — see the collapsed rail's abbreviation). */}
            {editingName === group.projectId ? (
              <InlineLabelEdit
                initial={group.name}
                maxLength={100}
                className="block w-full px-3 pb-1 pt-2 text-2xs font-medium tracking-wide text-fg"
                onCommit={(v) => commitName(group, v)}
                onCancel={() => setEditingName(null)}
              />
            ) : (
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <Link
                    to={`/project/${group.projectId}`}
                    {...menuOnDoubleClick()}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(PROJECT_MIME, group.projectId);
                      setDragProject(group.projectId);
                    }}
                    onDragEnd={() => setDragProject(null)}
                    className={cn(
                      'block truncate px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide transition-colors compact:pb-0.5 compact:pt-1.5',
                      appearanceColourClass(group.colour)
                        ? cn(appearanceColourClass(group.colour), 'hover:opacity-75')
                        : 'text-fg-gold hover:text-fg',
                      dragProject === group.projectId && 'opacity-50',
                    )}
                  >
                    {group.name}
                  </Link>
                </ContextMenuTrigger>
                <ProjectMenuBody
                  projectId={group.projectId}
                  name={group.name}
                  colour={group.colour}
                  actions={projectActions}
                  editLabel={{
                    label: 'Change project name',
                    onSelect: () => setEditingName(group.projectId),
                  }}
                />
              </ContextMenu>
            )}
            <CollapsibleSessions collapsed={dragProject !== null}>
              <ul className="flex flex-col gap-0.5 overflow-hidden compact:gap-0">
                {group.sessions.map((session) => (
                  <li
                    key={session.id}
                    draggable
                    onDragStart={(e) => {
                      const sessionIds = sessionsForDrag(visibleIds, selection.ids, session.id);
                      // Reorders within the list AND, dropped on a tiling pane,
                      // opens the grabbed session there as a permanent tab. A
                      // selected batch travels beside that single-tab payload
                      // for the archive target.
                      e.dataTransfer.setData(
                        TAB_MIME,
                        encodeTabTransfer({ type: 'terminal', session: session.id }),
                      );
                      e.dataTransfer.setData(SESSION_DRAG_MIME, encodeSessionDrag(sessionIds));
                      e.dataTransfer.effectAllowed = 'copyMove';
                      if (sessionIds.length > 1) setCountDragImage(e, sessionIds.length);
                      if (!selection.ids.has(session.id)) selection.onSelectOnly(session.id);
                      setDragging({ sourceId: session.id, sessionIds });
                    }}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragging?.sessionIds.length === 1 && dragging.sourceId !== session.id)
                        move(dragging.sourceId, session.id);
                    }}
                    className={cn(
                      'transition-opacity',
                      dragging?.sessionIds.includes(session.id) && 'opacity-50',
                    )}
                  >
                    <SessionRow
                      session={session}
                      activeSessionId={activeSessionId}
                      accountLabel={accountLabel}
                      onPromote={onPromote}
                      onArchived={onArchived}
                      selectedIds={selectedIds}
                      selection={selection}
                      ellipsis
                    />
                  </li>
                ))}
              </ul>
            </CollapsibleSessions>
          </div>
        ))}
      </div>
      {/* Archived sessions: hidden by default under a collapsible header at the
          bottom, never deleted — click one to reopen it and read its history
          (SPEC §4). Open, the pane is GROUPED BY PROJECT exactly as the live
          list is, each row saying when it was last active, and its top border
          drags to give the pane more (or less) of the sidebar. */}
      {(archived.length > 0 || sessionDragActive) && (
        <>
          {showArchived && <HeightHandle handle={handle} label="Resize the archived sessions" />}
          <div
            className="flex shrink-0 flex-col pb-1.5"
            // Sized only while open (closed, the header is all there is). The
            // percentage cap resolves against the sidebar's own definite height,
            // so a pane dragged tall elsewhere cannot swallow the live list here.
            style={showArchived ? { height: archivedHeight, maxHeight: '70%' } : undefined}
          >
            <button
              ref={archiveDrop.setNodeRef}
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              {...archiveDrop.props}
              className={cn(
                'flex w-full items-center gap-1.5 px-3 py-1.5 text-2xs uppercase tracking-wide text-fg-gold transition-colors hover:text-fg',
                archiveDrop.armed && 'bg-selection text-fg',
              )}
            >
              <ChevronRight
                className={cn('size-3 transition-transform', showArchived && 'rotate-90')}
              />
              <Archive className="size-3" />
              <span>Archived</span>
              <span className="ml-auto tabular-nums">{archived.length}</span>
            </button>
            {showArchived && (
              <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {archivedGroups.map((group) => (
                  <div key={group.projectId}>
                    {/* Dimmer than a live group's header and inert: archived rows
                        are for finding one session again, not for navigating
                        projects (that is the live list's header, right above). */}
                    {group.name !== '' && (
                      <div
                        className={cn(
                          'truncate px-3 pb-0.5 pt-1.5 text-2xs font-medium uppercase tracking-wide',
                          appearanceColourClass(group.colour)
                            ? cn(appearanceColourClass(group.colour), 'opacity-70')
                            : 'text-fg-muted',
                        )}
                      >
                        {group.name}
                      </div>
                    )}
                    <ul className="flex flex-col gap-0.5 compact:gap-0">
                      {group.sessions.map((session) => (
                        <li key={session.id}>
                          <SessionRow
                            session={session}
                            activeSessionId={activeSessionId}
                            accountLabel={accountLabel}
                            onArchived={onArchived}
                            ellipsis
                            lastActive
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
