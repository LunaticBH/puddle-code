import type { GitArea } from '@puddle/shared';
import { useWorktreeDiff } from '../../lib/queries/worktree-queries';
import { FileDiffContent } from './FileDiffContent';

/**
 * One changed file's worktree diff, hosted as a centre-editor tab (SPEC §8):
 * the navigator's Diff list opens these. Re-derives the entry from the live
 * worktree diff by path (rather than freezing status/against into the tab) so
 * the diff stays current as the agent works — `useWorktreeDiff` polls. The
 * modified side IS the shared editor buffer, so ⌘S here saves through the very
 * same path a file tab uses (FileDiffContent owns that).
 */
export function DiffTabBody({
  session,
  path,
  root,
  area,
  focused = true,
}: {
  session: string;
  path: string;
  /** `?root=` when the tab was opened against a directory target (12.4). */
  root?: string;
  /** Source-control comparison; absent preserves the session-vs-base diff. */
  area?: GitArea;
  focused?: boolean;
}) {
  const diff = useWorktreeDiff(session, {
    root,
    against: area === undefined ? 'base' : 'head',
    area,
  });

  if (diff.isPending) {
    return <div className="px-4 py-3 text-xs text-fg-muted">Loading diff…</div>;
  }
  if (diff.error) {
    return (
      <div className="px-4 py-3 text-xs text-fg-muted">
        {diff.error instanceof Error ? diff.error.message : 'Failed to load diff'}
      </div>
    );
  }

  const entry = diff.data.entries.find((e) => e.path === path);
  if (!entry) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-fg-muted">
        No changes to <span className="mx-1 text-fg-secondary">{path}</span> against the base.
      </div>
    );
  }

  return (
    <div className="h-full">
      <FileDiffContent
        session={session}
        against={diff.data.against}
        entry={entry}
        root={root}
        area={area}
        focused={focused}
      />
    </div>
  );
}
