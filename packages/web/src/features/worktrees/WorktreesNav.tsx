import { useMemo, useState } from 'react';
import { GitBranch, Trash2 } from 'lucide-react';
import {
  hostBasename,
  hostPathStyle,
  type OrphanBranch,
  type Session,
  type WorktreeInfo,
} from '@puddle/shared';
import { HoverMarquee } from '../../components/hover-marquee';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { hostPathKey } from '../../lib/host-path';
import { useDeleteBranch, usePruneWorktree, useRepoWorktrees } from '../../lib/queries/queries';
import { windowsRefusalMessage } from '../../lib/transport/windows-refusals';
import { cn } from '../../lib/utils';

const LIVE = new Set(['starting', 'running', 'waiting_input']);

// Each worktrees row/heading scrolls a too-long branch or directory name into
// view only on ITS OWN hover (the unnamed `group` on that element) — not all at
// once — so the list stays calm. Literal so Tailwind generates it.
const ROW_MARQUEE = 'group-hover:[transform:translateX(var(--tail))]';

function basename(path: string): string {
  if (hostPathStyle(path) === 'win32') return hostBasename(path) || path;
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** A small muted status tag (no border/box — HUMANS.md). */
function Tag({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className={cn('shrink-0 text-2xs', className)}>
      {children}
    </span>
  );
}

/** A trash control that appears on hover (disabled when a reason is given). */
function PruneButton({
  label,
  blockReason,
  onClick,
}: {
  label: string;
  blockReason: string | null;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={blockReason !== null}
          onClick={onClick}
          // Reveal by display, not opacity, so at rest the control reserves no
          // width — the row's badges reach the sidebar edge (HUMANS.md). A
          // blocked control never shows and never occupies space. The negative
          // vertical margin cancels the padding's height so the appearing
          // button never exceeds the row's resting text line — revealing it
          // must not make the row (and the whole list below) jump.
          className={cn(
            '-my-1 rounded-sm p-1 text-fg-gold transition-colors hover:text-danger',
            blockReason !== null
              ? 'hidden'
              : 'hidden group-hover:inline-flex pointer-coarse:inline-flex',
          )}
        >
          <Trash2 className="size-3.5" />
          <span className="sr-only">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {blockReason ? `Can't ${label.toLowerCase()} — ${blockReason}` : label}
      </TooltipContent>
    </Tooltip>
  );
}

type Target =
  | { kind: 'worktree'; path: string; branch: string | null }
  | { kind: 'branch'; name: string; localOnly: boolean };

/**
 * The Worktrees navigator (SPEC §8): every git worktree of the repo grouped by
 * branch, plus the local branches that have no worktree. Pruning removes a
 * worktree's directory (the branch is kept) and is blocked for the clone, a
 * dirty worktree, or one with a live session. An orphaned branch (no worktree)
 * can be deleted; a purely-local one warns first, since that discards its
 * unpushed commits. All guards are also enforced by the daemon.
 */
export function WorktreesNav({
  repoId,
  projectId,
  sessions,
}: {
  repoId: number;
  projectId: string;
  sessions: Session[];
}) {
  const worktrees = useRepoWorktrees(repoId);
  const prune = usePruneWorktree(repoId, projectId);
  const deleteBranch = useDeleteBranch(repoId, projectId);
  const [target, setTarget] = useState<Target | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = prune.isPending || deleteBranch.isPending;

  // Live sessions per worktree directory — running agents block a prune. Keyed
  // by `hostPathKey`: on a Windows host git lists `C:/…/wt` where a session
  // records `C:\…\wt` (exact strings on POSIX).
  const liveByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) {
      if (!LIVE.has(s.status)) continue;
      const key = hostPathKey(s.worktree_path);
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [sessions]);

  // Worktrees grouped by branch; the clone's group leads, then alphabetical.
  const groups = useMemo(() => {
    const byBranch = new Map<string, WorktreeInfo[]>();
    for (const w of worktrees.data?.worktrees ?? []) {
      const key = w.branch ?? '(detached)';
      (byBranch.get(key) ?? byBranch.set(key, []).get(key)!).push(w);
    }
    return [...byBranch.entries()].sort(([, a], [, b]) => {
      const ap = a.some((w) => w.is_primary) ? 0 : 1;
      const bp = b.some((w) => w.is_primary) ? 0 : 1;
      return ap - bp || (a[0]?.branch ?? '').localeCompare(b[0]?.branch ?? '');
    });
  }, [worktrees.data]);

  const orphans: OrphanBranch[] = useMemo(
    () => [...(worktrees.data?.orphan_branches ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [worktrees.data],
  );

  if (worktrees.isPending) {
    return <div className="px-3 py-2 text-xs text-fg-muted">Loading worktrees…</div>;
  }
  if (worktrees.error) {
    return (
      <div className="px-3 py-2 text-xs text-fg-muted">
        {worktrees.error instanceof Error ? worktrees.error.message : 'Failed to load worktrees'}
      </div>
    );
  }

  const confirm = () => {
    if (!target) return;
    setError(null);
    const onError = (e: Error) => setError(windowsRefusalMessage(e) ?? e.message);
    const onSuccess = () => setTarget(null);
    if (target.kind === 'worktree') prune.mutate(target.path, { onSuccess, onError });
    else deleteBranch.mutate({ name: target.name, confirm: true }, { onSuccess, onError });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2">
      {groups.length === 0 && orphans.length === 0 && (
        <div className="px-3 py-2 text-xs text-fg-muted">No worktrees.</div>
      )}

      {groups.map(([branch, wts]) => (
        <div key={`wt:${branch}`}>
          <div className="group flex items-center gap-1.5 px-3 pb-0.5 pt-2 text-2xs text-fg-muted">
            <GitBranch className="size-3 shrink-0 text-fg-gold" />
            <HoverMarquee text={branch} hoverClass={ROW_MARQUEE} />
          </div>
          {wts.map((wt) => {
            const live = liveByPath.get(hostPathKey(wt.path)) ?? 0;
            const blockReason = wt.is_primary
              ? 'the repository clone'
              : wt.dirty
                ? 'uncommitted changes'
                : live > 0
                  ? `${live} running session${live > 1 ? 's' : ''}`
                  : null;
            return (
              <div
                key={wt.path}
                className="group flex items-center gap-2 px-3 py-1 pl-6 transition-colors hover:bg-elevated"
              >
                <HoverMarquee
                  text={basename(wt.path)}
                  title={wt.path}
                  className="text-xs text-fg"
                  hoverClass={ROW_MARQUEE}
                />
                {wt.is_primary && <Tag className="text-fg-muted">clone</Tag>}
                {/* Terse badges (VSCode-style): M = modified/uncommitted (the
                    explorer's decoration colour), a count of live sessions in
                    the running colour. */}
                {wt.dirty && (
                  <Tag className="text-warning" title="Modified — uncommitted changes">
                    M
                  </Tag>
                )}
                {live > 0 && (
                  <Tag
                    className="text-running"
                    title={`${live} running session${live > 1 ? 's' : ''}`}
                  >
                    {live}
                  </Tag>
                )}
                <PruneButton
                  label="Prune"
                  blockReason={blockReason}
                  onClick={() => {
                    setError(null);
                    setTarget({ kind: 'worktree', path: wt.path, branch: wt.branch });
                  }}
                />
              </div>
            );
          })}
        </div>
      ))}

      {orphans.length > 0 && (
        <>
          <div className="px-3 pb-0.5 pt-3 text-2xs font-medium uppercase tracking-wide text-fg-gold">
            Branches without a worktree
          </div>
          {orphans.map((b) => (
            <div
              key={`br:${b.name}`}
              className="group flex items-center gap-2 px-3 py-1 transition-colors hover:bg-elevated"
            >
              <GitBranch className="size-3 shrink-0 text-fg-gold" />
              <HoverMarquee text={b.name} className="text-xs text-fg" hoverClass={ROW_MARQUEE} />
              {b.local_only && <Tag className="text-warning">local only</Tag>}
              <PruneButton
                label="Delete branch"
                blockReason={null}
                onClick={() => {
                  setError(null);
                  setTarget({ kind: 'branch', name: b.name, localOnly: b.local_only });
                }}
              />
            </div>
          ))}
        </>
      )}

      <Dialog
        open={target !== null}
        onOpenChange={(o) => {
          if (!o) setTarget(null);
        }}
      >
        <DialogContent>
          {target?.kind === 'branch' ? (
            <>
              <DialogHeader>
                <DialogTitle>Delete branch</DialogTitle>
                <DialogDescription>
                  Delete branch <span className="text-fg">{target.name}</span>? This removes the
                  branch from the repository.
                </DialogDescription>
              </DialogHeader>
              {target.localOnly && (
                <p className="text-xs text-warning">
                  <span>{target.name}</span> has commits on no remote — deleting it discards that
                  work permanently.
                </p>
              )}
            </>
          ) : (
            <DialogHeader>
              <DialogTitle>Prune worktree</DialogTitle>
              <DialogDescription>
                Remove <span className="text-fg">{target ? basename(target.path) : ''}</span>? The
                working directory is deleted; the branch{' '}
                <span className="text-fg">{target?.branch ?? ''}</span> is kept.
              </DialogDescription>
            </DialogHeader>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" disabled={pending} onClick={confirm}>
              {target?.kind === 'branch' ? 'Delete' : 'Prune'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
