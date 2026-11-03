import { useMemo, useState } from 'react';
import { HoverMarquee } from '../../components/hover-marquee';
import { requestReveal } from '../../lib/navigation/reveal-in-tree';
import { useCommitShow, useWorktreeLog } from '../../lib/queries/worktree-queries';
import { cn } from '../../lib/utils';
import { diffStatusStyle } from '../diff/diff-status';
import { relativeTime } from '../history/history-logic';
import { computeCommitGraph, type GraphLane } from './commit-graph-layout';
import { COMMIT_ROW_H, FILE_ROW_H, LANE_W, GraphCell, ContinuationCell } from './commit-graph-cell';

const SHA_LEN = 7;
// A too-long commit subject eases into view on ITS OWN row's hover (the
// unnamed `group` on the row button), matching the worktrees navigator's
// branch rows. Literal so Tailwind generates it.
const ROW_MARQUEE = 'group-hover:[transform:translateX(var(--tail))]';

/** One expanded commit's changed files; each opens its sha^→sha diff tab. */
function CommitFiles({
  session,
  sha,
  root,
  lanes,
  gutterW,
  onOpen,
}: {
  session: string;
  sha: string;
  root?: string;
  lanes: GraphLane[];
  gutterW: number;
  onOpen: (path: string, sha: string, opts?: { preview?: boolean }) => void;
}) {
  const show = useCommitShow(session, sha, root);
  const note = (text: string) => (
    <div className="flex items-center" style={{ height: FILE_ROW_H }}>
      <ContinuationCell lanes={lanes} width={gutterW} />
      <span className="px-2 text-2xs text-fg-muted">{text}</span>
    </div>
  );

  if (show.isPending) return note('…');
  if (show.error) {
    return note(show.error instanceof Error ? show.error.message : 'Failed to load commit');
  }
  if (show.data.files.length === 0) return note('No file changes.');

  return (
    <>
      {show.data.files.map((entry) => {
        const style = diffStatusStyle(entry.status);
        const label =
          entry.status === 'renamed' && entry.old_path
            ? `${entry.old_path} → ${entry.path}`
            : entry.path;
        return (
          <button
            key={`${entry.status}:${entry.old_path ?? ''}:${entry.path}`}
            type="button"
            title={label}
            // Peek on a single click, pin on a double — a files-tree click's
            // semantics, so a result behaves like a file (SPEC §8).
            onClick={() => {
              onOpen(entry.path, sha);
              requestReveal({ path: entry.path, root });
            }}
            onDoubleClick={() => onOpen(entry.path, sha, { preview: false })}
            className="group flex w-full items-center text-left transition-colors hover:bg-elevated"
            style={{ height: FILE_ROW_H }}
          >
            <ContinuationCell lanes={lanes} width={gutterW} />
            <span
              className={cn('mr-1.5 w-3 shrink-0 text-center font-mono text-xs', style.colourClass)}
            >
              {style.letter}
            </span>
            <HoverMarquee text={label} className="pr-3 text-2xs text-fg" hoverClass={ROW_MARQUEE} />
          </button>
        );
      })}
    </>
  );
}

/**
 * The commit-graph panel of the Changes navigator (SPEC §8): the worktree's
 * history as an interactive DAG. Each commit is a clickable row — clicking
 * expands its changed files inline (the graph lanes carry straight through),
 * and clicking a file opens its `sha^ → sha` diff as a read-only editor tab.
 * The graph itself is a per-row SVG gutter laid out by `computeCommitGraph`.
 */
export function CommitGraph({
  session,
  root,
  onOpenCommitFile,
}: {
  session: string;
  /** `?root=` for a directory target (protocol 12.4); undefined for a worktree. */
  root?: string;
  onOpenCommitFile: (path: string, sha: string, opts?: { preview?: boolean }) => void;
}) {
  const log = useWorktreeLog(session, { root });
  const [openSha, setOpenSha] = useState<string | null>(null);

  const commits = useMemo(() => log.data?.pages.flatMap((p) => p.commits) ?? [], [log.data]);
  const layout = useMemo(() => computeCommitGraph(commits), [commits]);
  const gutterW = Math.max(1, layout.laneCount) * LANE_W + LANE_W / 2;

  if (log.isPending) {
    return <div className="px-3 py-2 text-xs text-fg-muted">Loading history…</div>;
  }
  if (log.error) {
    return (
      <div className="px-3 py-2 text-xs text-fg-muted">
        {log.error instanceof Error ? log.error.message : 'Failed to load history'}
      </div>
    );
  }
  if (commits.length === 0) {
    return <div className="px-3 py-2 text-xs text-fg-muted">No commits yet.</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2">
      {layout.rows.map((row, i) => {
        const commit = commits[i]!;
        const open = openSha === row.sha;
        return (
          <div key={row.sha}>
            <button
              type="button"
              onClick={() => setOpenSha(open ? null : row.sha)}
              className={cn(
                'group flex w-full items-center text-left transition-colors hover:bg-elevated',
                open && 'bg-selection',
              )}
              style={{ height: COMMIT_ROW_H }}
            >
              <GraphCell row={row} width={gutterW} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 pr-3">
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-2xs text-fg-muted">
                    {row.sha.slice(0, SHA_LEN)}
                  </span>
                  <HoverMarquee
                    text={commit.subject}
                    className="text-xs text-fg"
                    hoverClass={ROW_MARQUEE}
                  />
                </div>
                <span className="truncate text-2xs text-fg-muted">
                  {commit.author_name} ·{' '}
                  <span className="tabular-nums">{relativeTime(commit.authored_at)}</span>
                </span>
              </div>
            </button>
            {open && (
              <CommitFiles
                session={session}
                sha={row.sha}
                root={root}
                lanes={row.below}
                gutterW={gutterW}
                onOpen={onOpenCommitFile}
              />
            )}
          </div>
        );
      })}
      {log.hasNextPage && (
        <button
          type="button"
          onClick={() => void log.fetchNextPage()}
          disabled={log.isFetchingNextPage}
          className="px-3 py-2 text-left text-xs text-fg-muted transition-colors hover:bg-elevated"
        >
          {log.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  );
}
