import { Fragment, useEffect, useState } from 'react';
import { HeightHandle, useResizableHeight } from '../../components/resizable-height';
import { useDaemonVersion } from '../../lib/queries/queries';
import { sourceControlSupported } from '../../lib/transport/protocol-support';
import { useGitRepositories } from '../../lib/queries/worktree-queries';
import { CommitGraph } from './CommitGraph';
import { UncommittedPanel } from './UncommittedPanel';
import { SourceControlRepository, type SourceControlOpenOptions } from './SourceControlRepository';

/**
 * The unified Changes navigator (SPEC §8): the worktree's uncommitted changes
 * on top and its commit-dependency graph below, replacing the separate Diff and
 * History navigators. The top panel lists working-tree changes (staged +
 * unstaged) as a tree or flat list; the bottom panel is the interactive commit
 * graph. Both open their content as centre-editor tabs, keeping the editor the
 * single content surface.
 */
export function ChangesNav({
  session,
  root,
  activeDiffPath,
  onOpenDiff,
  onOpenCommitFile,
}: {
  session: string;
  /**
   * `?root=` for a directory target — the project's own repository, when no
   * session is bound (protocol 12.4). Undefined for a session's worktree.
   */
  root?: string;
  /** Path of the active editor tab when it is an uncommitted diff for `session`. */
  activeDiffPath: string | null;
  onOpenDiff: (path: string, opts?: SourceControlOpenOptions) => void;
  onOpenCommitFile: (path: string, sha: string, opts?: SourceControlOpenOptions) => void;
}) {
  // The border between the two panels drags (SPEC §8): the uncommitted list
  // above is sized, History below takes the rest. The percentage cap keeps a
  // height dragged in a tall sidebar from crowding History in a short one.
  const { height, handle } = useResizableHeight('changes-uncommitted', 240, {
    sized: 'above',
    min: 80,
  });
  const version = useDaemonVersion();
  const modern = version.data !== undefined && sourceControlSupported(version.data.protocol);
  const repositories = useGitRepositories(session, { root, enabled: modern });
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  useEffect(() => {
    if (!modern || !repositories.data) return;
    const available = repositories.data.repositories;
    if (!selectedRoot || !available.some((repository) => repository.root === selectedRoot)) {
      setSelectedRoot(available[0]?.root ?? null);
    }
  }, [modern, repositories.data, selectedRoot]);
  const historyRoot = modern ? (selectedRoot ?? root) : root;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section className="flex shrink-0 flex-col" style={{ height, maxHeight: '70%' }}>
        {modern ? (
          <div className="min-h-0 flex-1 overflow-y-auto pb-1">
            {repositories.isPending ? (
              <div className="px-3 py-2 text-xs text-fg-muted">Loading repositories…</div>
            ) : repositories.error ? (
              <div className="px-3 py-2 text-xs text-fg-muted">
                {repositories.error instanceof Error
                  ? repositories.error.message
                  : 'Failed to load repositories'}
              </div>
            ) : repositories.data.repositories.length === 0 ? (
              <div className="px-3 py-2 text-xs text-fg-muted">No Git repositories.</div>
            ) : (
              repositories.data.repositories.map((repository, index) => (
                <Fragment key={repository.root}>
                  {index > 0 && <div className="mx-3 my-2 h-px bg-border" />}
                  <SourceControlRepository
                    session={session}
                    targetRoot={root}
                    repository={repository}
                    selected={selectedRoot === repository.root}
                    activePath={activeDiffPath}
                    onSelect={() => setSelectedRoot(repository.root)}
                    onOpen={onOpenDiff}
                  />
                </Fragment>
              ))
            )}
          </div>
        ) : (
          <UncommittedPanel
            session={session}
            root={root}
            activePath={activeDiffPath}
            onOpen={onOpenDiff}
          />
        )}
      </section>
      <HeightHandle handle={handle} label="Resize the uncommitted changes" />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-7 shrink-0 items-center px-3">
          <span className="text-2xs font-medium uppercase tracking-wide text-fg-gold">History</span>
        </div>
        <CommitGraph
          session={session}
          root={historyRoot}
          onOpenCommitFile={(path, sha, opts) =>
            onOpenCommitFile(path, sha, { ...opts, root: historyRoot })
          }
        />
      </div>
    </div>
  );
}
