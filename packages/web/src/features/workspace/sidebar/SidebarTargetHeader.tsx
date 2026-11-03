import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronsDownUp, Pin, RefreshCw, type LucideIcon } from 'lucide-react';
import type { Session } from '@puddle/shared';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { useHostInfo } from '../../../lib/queries/queries';
import { tildify } from '../../../lib/tildify';
import { cn } from '../../../lib/utils';
import { useExplorerOptional } from '../../explorer/explorer-context';
import type { ExplorerTarget } from '../../explorer/use-explorer-target';
import { useSessionTitleRenderer } from '../../profile/use-session-title';
import { TabTooltipBody } from '../panes/TabTooltip';

/**
 * The bound-worktree title: a horizontally scrollable strip (no scrollbar) that
 * ANCHORS to its right end, so the deepest, most identifying part of an absolute
 * path stays visible; scroll left to read the root. No auto-scroll — that read
 * as distracting.
 */
function PathScroller({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const anchorRight = () => {
      el.scrollLeft = el.scrollWidth;
    };
    anchorRight();
    const ro = new ResizeObserver(anchorRight);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <div ref={ref} className="no-scrollbar min-w-0 flex-1 overflow-x-auto">
      <span className={cn('inline-block whitespace-nowrap', className)}>{text}</span>
    </div>
  );
}

/**
 * The left sidebar's bound-worktree header (SPEC §8), shown under the icon row
 * for every navigator (Files, Changes, Search): it names the one current
 * file-tree location all three operate over, carries the pin toggle, and offers
 * a dropdown to pin any other project worktree by hand. In files mode
 * (`showFileActions`) it also hosts the explorer utility cluster — Refresh ·
 * Collapse Folders (creation lives in the tree's context menus, not here — the
 * header stays uncluttered).
 */
export function SidebarTargetHeader({
  sessions,
  target,
  showFileActions = false,
  location,
}: {
  sessions: Session[];
  target: ExplorerTarget;
  showFileActions?: boolean;
  /** Absolute root currently shown by Files and queried by Changes/Search. */
  location?: string | null;
}) {
  const { session, pinned, pin, unpin, isProjectDirectory } = target;
  const renderTitle = useSessionTitleRenderer();
  const home = useHostInfo().data?.home;
  const pickable = sessions.filter((s) => s.status !== 'archived');
  // ~-compress the daemon home so the identifying tail gets the width (SPEC §8).
  // `location` overrides the bound worktree while Files is browsing elsewhere;
  // every navigator receives the same value from NavigatorSidebar.
  const resolvedLocation = location ?? target.root ?? session?.worktree_path ?? null;
  const title = resolvedLocation ? tildify(resolvedLocation, home) : 'No worktree';

  return (
    <div className="group relative flex h-8 shrink-0 items-center px-2">
      <PathScroller text={title} className="text-xs text-fg-secondary" />
      {/* Controls overlay the right edge, revealed on hover/focus, so at rest
          the title uses the full width — no hidden icon reserves space (the pin
          stays shown while pinned to keep that state visible). The `bg-surface`
          (the sidebar's colour) masks the title tail beneath them. */}
      <div
        className={cn(
          'absolute inset-y-0 right-1 flex items-center gap-1 bg-surface pl-2 opacity-0 transition-opacity',
          'pointer-events-none focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100',
          pinned && 'pointer-events-auto opacity-100',
        )}
      >
        {showFileActions && session && <ExplorerActions />}
        <button
          type="button"
          aria-pressed={pinned}
          disabled={!session || isProjectDirectory}
          title={
            isProjectDirectory
              ? 'The project directory is the fallback binding — nothing to pin'
              : pinned
                ? 'Unpin — follow the active session'
                : 'Pin the sidebar to this worktree'
          }
          onClick={() => (pinned ? unpin() : session && pin(session.id))}
          className={cn(
            'shrink-0 rounded-sm p-1 transition-colors disabled:pointer-events-none disabled:opacity-40',
            pinned ? 'text-fg' : 'text-fg-gold hover:bg-elevated hover:text-fg',
          )}
        >
          <Pin className={cn('size-3.5', pinned && 'fill-current')} />
          <span className="sr-only">{pinned ? 'Unpin sidebar' : 'Pin sidebar'}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="Bind a different worktree"
              className="shrink-0 rounded-sm p-1 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
            >
              <ChevronDown className="size-3.5" />
              <span className="sr-only">Choose a worktree</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {pickable.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-fg-muted">No sessions yet</div>
            ) : (
              pickable.map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  onSelect={() => pin(s.id)}
                  className="min-w-64 items-start"
                >
                  <TabTooltipBody name={renderTitle(s)} session={s} />
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

const ACTIONS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: 'refresh', label: 'Refresh', icon: RefreshCw },
  { key: 'collapse', label: 'Collapse Folders', icon: ChevronsDownUp },
];

/** The explorer utility cluster, revealed on header hover (HUMANS.md: no borders, fill-shift). */
function ExplorerActions() {
  const ex = useExplorerOptional();
  if (!ex) return null;
  const run = (key: string) => {
    if (key === 'refresh') ex.refresh();
    else if (key === 'collapse') ex.collapseAll();
  };
  // `hidden` (not opacity-0) so at rest the cluster takes NO layout width —
  // otherwise the header's bg-surface overlay masks that phantom span over the
  // path tail, which is visible whenever the header is pinned (overlay always
  // shown). Revealed by the parent header's hover/focus (HUMANS.md).
  return (
    <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
      {ACTIONS.map(({ key, label, icon: Icon }) => (
        <Tooltip key={key}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => run(key)}
              className="rounded-sm p-1 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
            >
              <Icon className="size-3.5" />
              <span className="sr-only">{label}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
