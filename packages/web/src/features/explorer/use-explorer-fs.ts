import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  copyEntry,
  createEntry,
  deleteEntry,
  renameEntry,
  transferEntry,
} from '../../lib/queries/worktree-queries';
import { basename, joinPath, type VisibleRow } from './explorer-paths';
import {
  sameFiletree,
  type ExplorerClipboardState,
  type ExplorerClipboardTarget,
} from './clipboard-store';

/**
 * The explorer's on-disk mutations wired to their query invalidation and error
 * toasts (SPEC §8). Every op refetches the whole worktree tree and the git
 * status map (prefix-keyed invalidation) so decorations and rows stay live —
 * including edits a concurrent agent makes in the same worktree. Errors surface
 * as a toast and resolve to a falsy result rather than throwing.
 *
 * `root` (protocol 12.3) sends each op the browse override: the same mutations,
 * resolved against a directory ABOVE the worktree. Paths stay relative — they
 * are simply relative to that root — so nothing else here changes.
 */
export interface ExplorerFs {
  create(parentDir: string, name: string, kind: 'file' | 'dir'): Promise<string | null>;
  rename(from: string, newName: string): Promise<string | null>;
  /** Move entries into another directory, keeping their names (drag-move). */
  move(paths: string[], targetDir: string): Promise<void>;
  remove(paths: string[]): Promise<void>;
  /** Paste and return exactly the source paths that failed. */
  paste(clipboard: ExplorerClipboardState, targetDir: string): Promise<string[]>;
}

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export function useExplorerFs(sid: string, root?: string, directory = root ?? ''): ExplorerFs {
  const qc = useQueryClient();

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['wt-tree', sid] });
    void qc.invalidateQueries({ queryKey: ['wt-git-status', sid] });
  }, [qc, sid]);

  const invalidateTarget = useCallback(
    (target: ExplorerClipboardTarget) => {
      void qc.invalidateQueries({ queryKey: ['wt-tree', target.sid] });
      void qc.invalidateQueries({ queryKey: ['wt-git-status', target.sid] });
    },
    [qc],
  );

  return useMemo<ExplorerFs>(
    () => ({
      async create(parentDir, name, kind) {
        try {
          const res = await createEntry(sid, joinPath(parentDir, name), kind, root);
          invalidate();
          return res.path;
        } catch (e) {
          toast.error(message(e, `Couldn't create ${name}`));
          return null;
        }
      },
      async rename(from, newName) {
        const to = joinPath(
          from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '',
          newName,
        );
        try {
          const res = await renameEntry(sid, from, to, root);
          invalidate();
          return res.path;
        } catch (e) {
          toast.error(message(e, `Couldn't rename ${basename(from)}`));
          return null;
        }
      },
      async move(paths, targetDir) {
        const results = await Promise.allSettled(
          paths.map((p) => renameEntry(sid, p, joinPath(targetDir, basename(p)), root)),
        );
        invalidate();
        const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed.length > 0) {
          toast.error(
            paths.length === 1
              ? message(failed[0]!.reason, `Couldn't move ${basename(paths[0]!)}`)
              : `Couldn't move ${failed.length} item${failed.length > 1 ? 's' : ''}`,
          );
        }
      },
      async remove(paths) {
        const results = await Promise.allSettled(paths.map((p) => deleteEntry(sid, p, root)));
        invalidate();
        const failed = results.filter((r) => r.status === 'rejected').length;
        if (failed > 0) toast.error(`Couldn't delete ${failed} item${failed > 1 ? 's' : ''}`);
        else
          toast.success(
            paths.length === 1 ? `Deleted ${basename(paths[0]!)}` : `Deleted ${paths.length} items`,
          );
      },
      async paste(clipboard, targetDir) {
        const destination = { sid, root, directory };
        const local = sameFiletree(clipboard.source, destination);
        const results = await Promise.allSettled(
          clipboard.paths.map((path) => {
            const to = joinPath(targetDir, basename(path));
            if (local) {
              const op = clipboard.mode === 'cut' ? renameEntry : copyEntry;
              return op(sid, path, to, root);
            }
            return transferEntry(
              sid,
              {
                operation: clipboard.mode === 'cut' ? 'move' : 'copy',
                source: {
                  session_id: clipboard.source.sid,
                  root: clipboard.source.root,
                },
                from: path,
                to,
              },
              root,
            );
          }),
        );
        invalidate();
        if (!local && clipboard.mode === 'cut') invalidateTarget(clipboard.source);
        const failedPaths = clipboard.paths.filter(
          (_, index) => results[index]?.status === 'rejected',
        );
        if (failedPaths.length > 0) {
          toast.error(
            `Couldn't paste ${failedPaths.length} item${failedPaths.length > 1 ? 's' : ''}`,
          );
        }
        return failedPaths;
      },
    }),
    [sid, root, directory, invalidate, invalidateTarget],
  );
}

/** Whether a drag-move of `dragged` into `targetDir` is legal (not a no-op, not into its own subtree). */
export function canMoveInto(dragged: string, targetDir: string, row?: VisibleRow): boolean {
  if (row && row.type !== 'dir') return false;
  const currentParent = dragged.includes('/') ? dragged.slice(0, dragged.lastIndexOf('/')) : '';
  if (currentParent === targetDir) return false; // already there
  return targetDir === '' || !`${targetDir}/`.startsWith(`${dragged}/`);
}
