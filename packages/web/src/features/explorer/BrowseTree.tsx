import type { ReactNode } from 'react';
import { CornerLeftUp, Undo2 } from 'lucide-react';
import type { CompilationFileTarget, Session } from '@puddle/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { isHostRoot } from '../../lib/host-path';
import { ExplorerProvider } from './explorer-context';
import { FileExplorer } from './FileExplorer';

/**
 * The tree the explorer switches to when navigating ABOVE the worktree
 * (SPEC §8). It is the SAME tree — `ExplorerProvider` + `FileExplorer`, given a
 * browse `root` instead of the session's worktree — so everything a right-click
 * offers inside the worktree works out here too: create, rename, delete,
 * cut/copy/paste, drag-move, upload, download. Files open as fully editable
 * `external` tabs (10.4). Git decorations follow the root-qualified status
 * query; only "Open Terminal in Directory" stays absent because the daemon
 * confines a terminal's `cwd` to the worktree (11.1).
 *
 * `readOnly` covers the one case where the mutations must NOT be offered: a
 * daemon older than protocol 12.3 ignores `?root=` on the fs routes and would
 * resolve those paths against the worktree, silently touching the wrong files.
 *
 * The utility row walks further up and returns to the worktree; the shared
 * sidebar header above it is the sole display of the current absolute location.
 */
export function BrowseTree({
  session,
  root,
  readOnly,
  boundHeader,
  onNavigateUp,
  onReset,
  onOpenFile,
  activePath,
  compilableExtensions,
  onOpenCompilationSettings,
}: {
  session: Session;
  root: string;
  readOnly: boolean;
  /**
   * The sidebar's bound-worktree header, rendered INSIDE the provider so its
   * explorer utilities (Refresh · Collapse Folders) drive this tree — the same
   * arrangement files mode uses for the worktree.
   */
  boundHeader: ReactNode;
  onNavigateUp: () => void;
  onReset: () => void;
  /** Open `path` (relative to `root`) as an external editor tab. */
  onOpenFile: (path: string, opts?: { preview?: boolean }) => void;
  /** Path of the active editor tab when it is a file under this root. */
  activePath: string | null;
  compilableExtensions: ReadonlySet<string>;
  onOpenCompilationSettings?: (source: CompilationFileTarget) => void;
}) {
  return (
    // Keyed by root: walking up is a different tree, so its expansion,
    // selection, and any in-flight inline edit start fresh.
    <ExplorerProvider
      key={root}
      session={session}
      root={root}
      readOnly={readOnly}
      onOpenFile={(_sid, path, opts) => onOpenFile(path, opts)}
      compilableExtensions={compilableExtensions}
      onOpenCompilationSettings={onOpenCompilationSettings}
      activePath={activePath}
    >
      {boundHeader}
      <BrowseHeader root={root} onNavigateUp={onNavigateUp} onReset={onReset} />
      <div className="flex min-h-0 flex-1 flex-col">
        <FileExplorer />
      </div>
    </ExplorerProvider>
  );
}

/**
 * The two ways out of an external browse. Its absolute path is deliberately not
 * repeated here: the shared navigator header is the one location display.
 */
function BrowseHeader({
  root,
  onNavigateUp,
  onReset,
}: {
  root: string;
  onNavigateUp: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center px-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onNavigateUp}
            disabled={isHostRoot(root)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-1 text-left text-fg-gold transition-colors hover:bg-elevated hover:text-fg disabled:pointer-events-none disabled:opacity-40"
          >
            <CornerLeftUp className="size-3.5 shrink-0" />
            <span className="text-xs text-fg-muted">..</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>{isHostRoot(root) ? root : 'Browse the parent directory'}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onReset}
            className="ml-1 shrink-0 rounded-sm p-1 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
          >
            <Undo2 className="size-3.5" />
            <span className="sr-only">Back to the worktree</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>Back to the worktree</TooltipContent>
      </Tooltip>
    </div>
  );
}
