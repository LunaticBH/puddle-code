import { useEffect, useRef, useState } from 'react';
import {
  CornerLeftUp,
  GitBranch,
  FolderGit2,
  FolderTree,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  type LucideIcon,
} from 'lucide-react';
import type { CompilationFileTarget, Session } from '@puddle/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { sameHostPath } from '../../../lib/host-path';
import { useDaemonVersion } from '../../../lib/queries/queries';
import { onReveal } from '../../../lib/navigation/reveal-in-tree';
import { cn } from '../../../lib/utils';
import { ChangesNav } from '../../changes/ChangesNav';
import type { SourceControlOpenOptions } from '../../changes/SourceControlRepository';
import { BrowseTree } from '../../explorer/BrowseTree';
import { ExplorerProvider } from '../../explorer/explorer-context';
import { parentDir } from '../../explorer/explorer-paths';
import { FileExplorer } from '../../explorer/FileExplorer';
import {
  explorerLocationPath,
  withBrowseReset,
  type ExplorerTarget,
} from '../../explorer/use-explorer-target';
import { SearchNav } from '../../search/SearchNav';
import { WorktreesNav } from '../../worktrees/WorktreesNav';
import { SidebarTargetHeader } from './SidebarTargetHeader';

export type SidebarMode = 'files' | 'changes' | 'search' | 'worktrees';

const MODES: { key: SidebarMode; label: string; icon: LucideIcon }[] = [
  { key: 'files', label: 'Files', icon: FolderTree },
  { key: 'search', label: 'Search', icon: Search },
  { key: 'changes', label: 'Changes', icon: GitBranch },
  { key: 'worktrees', label: 'Worktrees', icon: FolderGit2 },
];

/**
 * Maps a stored `sidebar_mode` onto a live navigator: the pre-unification
 * `diff`/`history` values both resolve to the merged `changes` view (SPEC §8),
 * so old snapshots keep working after the Diff+History unification.
 */
export function normalizeSidebarMode(mode: string): SidebarMode {
  if (mode === 'diff' || mode === 'history' || mode === 'changes') return 'changes';
  if (mode === 'search') return 'search';
  if (mode === 'worktrees') return 'worktrees';
  return 'files';
}

/**
 * The collapsed left navigator: a slim rail with the expand control on top
 * (mirroring the right sidebar, so the toggle stays visible when collapsed),
 * then the same mode icons — Files · Search · Changes — stacked vertically
 * (HUMANS.md minimalism, no border, a fill-shift on hover). The expand button
 * reopens to the last navigator; clicking a mode icon reopens straight to it
 * (SPEC §8).
 */
export function CollapsedSidebarRail({
  mode,
  onExpand,
  onSelect,
}: {
  mode: SidebarMode;
  onExpand: () => void;
  onSelect: (mode: SidebarMode) => void;
}) {
  return (
    <div className="flex h-full w-9 shrink-0 flex-col items-center gap-1 bg-surface py-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onExpand}
            className="flex items-center rounded-md p-1.5 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
          >
            <PanelLeftOpen className="size-4" />
            <span className="sr-only">Show sidebar</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Show sidebar</TooltipContent>
      </Tooltip>
      {MODES.map(({ key, label, icon: Icon }) => (
        <Tooltip key={key}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-current={mode === key ? 'page' : undefined}
              onClick={() => onSelect(key)}
              className={cn(
                'flex items-center rounded-md p-1.5 transition-colors',
                mode === key
                  ? 'bg-elevated text-fg'
                  : 'text-fg-gold hover:bg-elevated hover:text-fg',
              )}
            >
              <Icon className="size-4" />
              <span className="sr-only">{label}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * The left sidebar (SPEC §8): a horizontal icon row — Files · Search · Changes
 * — with the collapse control on the right. The pin (which binds the whole
 * sidebar to one worktree) lives in the bound-worktree header below the row, to
 * keep this row uncluttered; every navigator (files tree, the unified
 * changes/graph view, and search) follows the bound worktree, and unpinning
 * resumes follow-the-active-session. Selections open their content as
 * centre-editor tabs, keeping the editor the single content surface.
 */
export function NavigatorSidebar({
  mode,
  onModeChange,
  onCollapse,
  projectId,
  repoId,
  sessions,
  target,
  browseRequest,
  onFiletreeRootChange,
  compilableExtensions,
  onOpenCompilationSettings,
  onOpenFile,
  onOpenExternalFile,
  onOpenTerminalIn,
  activeFilePath,
  activeExternalTab,
  activeDiffPath,
  onOpenDiff,
  onOpenCommitFile,
  onOpenSearchFile,
}: {
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  onCollapse: () => void;
  projectId: string;
  repoId: number;
  sessions: Session[];
  /** The worktree the whole sidebar is bound to, plus its pin controls. */
  target: ExplorerTarget;
  /**
   * A terminal link to a DIRECTORY (SPEC §7): bind the tree to `root` as a
   * pinned browse for `session`. `nonce` re-fires the same directory twice.
   */
  browseRequest?: { session: string; root: string; nonce: number } | null;
  /** Report the absolute root currently represented by the Files tree. */
  onFiletreeRootChange?: (root: string | null) => void;
  compilableExtensions: ReadonlySet<string>;
  onOpenCompilationSettings?: (source: CompilationFileTarget) => void;
  onOpenFile: (sessionId: string, path: string, opts?: { preview?: boolean }) => void;
  /** Spawn a terminal whose shell starts in this worktree-relative directory. */
  onOpenTerminalIn: (sessionId: string, dir: string) => void;
  /** Open an `external` editor tab: `path` is relative to the browse `root` (SPEC §8). */
  onOpenExternalFile: (
    sessionId: string,
    path: string,
    root: string,
    opts?: { preview?: boolean },
  ) => void;
  /** Path of the active editor tab when it is a file in the bound worktree — highlighted in the tree. */
  activeFilePath: string | null;
  /** The active editor tab when it is an `external` file, for the browse tree's highlight. */
  activeExternalTab: { path: string; root: string } | null;
  /** Path of the active editor tab when it is an uncommitted diff for the bound worktree. */
  activeDiffPath: string | null;
  /** Results open PREVIEW tabs like a tree click; `preview: false` pins (SPEC §8). */
  onOpenDiff: (path: string, opts?: SourceControlOpenOptions) => void;
  onOpenCommitFile: (path: string, sha: string, opts?: SourceControlOpenOptions) => void;
  onOpenSearchFile: (path: string, line?: number, opts?: { preview?: boolean }) => void;
}) {
  const { session } = target;

  // Parent-directory browsing (SPEC §8): navigating above the worktree swaps
  // the files tree for the BrowseTree, rooted here. Keyed to the session it was
  // opened for, so binding to a DIFFERENT session drops it; leaving the pin
  // drops it explicitly (see sidebarTarget below), since that is not a change
  // of session. Entering it PINS the sidebar, so follow-the-active-session
  // cannot yank the tree away mid-browse. Ephemeral local state on purpose — a
  // reload lands back on the worktree.
  // A directory target (the project's own repository — SPEC §8) carries the
  // `?root=` every request for it must send. It is already "a directory that is
  // not a worktree", so the parent-directory browse has nothing to add on top:
  // walking up from here would need a second root, and the tree already IS
  // rooted. Hence `targetRoot` below feeds the explorer directly.
  const targetRoot = target.root;
  const [browse, setBrowse] = useState<{ forSession: string; root: string } | null>(null);
  // `?root=` needs a 10.2+ daemon: an older one IGNORES the param and serves
  // worktree-relative paths as if they were the parent directory — silently
  // wrong data — so the whole browse entry point hides on version skew (the
  // same stance as folder drops gating on 9.2). Unknown (still fetching)
  // reads as supported; skew within a major is rare.
  const protocol = useDaemonVersion().data?.protocol;
  const browseSupported =
    !protocol || protocol.major > 10 || (protocol.major === 10 && protocol.minor >= 2);
  // Mutating out there needs 12.3 (`?root=` on the fs routes). A 12.0–12.2
  // daemon serves the browse tree fine but would resolve a create/rename/delete
  // against the WORKTREE, so the tree goes read-only rather than wrong.
  const browseMutable =
    !protocol || protocol.major > 12 || (protocol.major === 12 && protocol.minor >= 3);
  const browseRoot =
    browseSupported && browse !== null && browse.forSession === session?.id ? browse.root : null;
  // What the file/git/search requests send: an explicit browse root wins, then
  // the target's own (a directory target), else nothing (a real worktree).
  const requestRoot = browseRoot ?? targetRoot;
  const locationPath = explorerLocationPath(target, browseRoot);
  useEffect(() => {
    onFiletreeRootChange?.(locationPath);
    return () => onFiletreeRootChange?.(null);
  }, [locationPath, onFiletreeRootChange]);
  const enterBrowse = (root: string) => {
    if (!session) return;
    if (!target.pinned) target.pin(session.id);
    setBrowse({ forSession: session.id, root });
  };

  // A reveal aimed at the ordinary bound tree (not the external browse that
  // may currently cover it) leaves that browse first. The reveal latch remains
  // pending until the newly mounted ExplorerProvider claims it.
  useEffect(
    () =>
      onReveal((request) => {
        const targetDirectory = targetRoot ?? session?.worktree_path;
        const aimedAtTarget =
          request.directory !== undefined
            ? targetDirectory !== undefined && sameHostPath(request.directory, targetDirectory)
            : request.root === targetRoot;
        if (browse !== null && aimedAtTarget) setBrowse(null);
      }),
    [browse, session?.worktree_path, targetRoot],
  );

  // A terminal link to a DIRECTORY (SPEC §7) enters the same pinned-browse
  // state the `..` walk does — so the return button and the unpin-leaves-
  // the-browse rule come for free — pinned to the session the link came
  // from (re-binding the sidebar if it was pinned elsewhere: the click IS
  // the user pointing at that session's directory). Consumed by nonce, so
  // a re-render cannot re-enter a browse the user has already backed out of.
  const consumedBrowse = useRef(0);
  useEffect(() => {
    if (!browseRequest || !browseSupported) return;
    if (consumedBrowse.current === browseRequest.nonce) return;
    consumedBrowse.current = browseRequest.nonce;
    target.pin(browseRequest.session);
    setBrowse({ forSession: browseRequest.session, root: browseRequest.root });
  }, [browseRequest, browseSupported, target]);

  // Unpinning leaves the browse too. The pin was applied BY entering the browse,
  // so releasing it has to hand the tree back — and keying the browse to a
  // session id alone could not do that, because unpinning usually does not
  // change which session is bound (it only changes how it is resolved), leaving
  // the tree stranded above the worktree while claiming to follow the active
  // tab. Every unpin path in this sidebar goes through the header, so wrapping
  // the target once here covers all of them.
  const sidebarTarget = withBrowseReset(target, () => setBrowse(null));

  // What Changes and Search are actually ABOUT: a directory, not a session.
  // Their remount key is therefore the worktree path (plus any request root),
  // not the session id (fixed 2026-08-04) — sessions joining one worktree, which
  // is puddle's default, used to remount both panels on every switch between
  // them, blanking a commit graph and a file list that were already showing the
  // right answer. A genuinely different directory still remounts, which is what
  // resets the graph's expansion and the search box.
  const navigatorScope = `${session?.worktree_path ?? ''}:${requestRoot ?? ''}`;

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center gap-1 px-2 py-1.5">
        {MODES.map(({ key, label, icon: Icon }) => (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-current={mode === key ? 'page' : undefined}
                onClick={() => onModeChange(key)}
                className={cn(
                  'flex items-center rounded-md p-1.5 transition-colors',
                  mode === key
                    ? 'bg-elevated text-fg'
                    : 'text-fg-gold hover:bg-elevated hover:text-fg',
                )}
              >
                <Icon className="size-4" />
                <span className="sr-only">{label}</span>
              </button>
            </TooltipTrigger>
            {/* Downwards, into the navigator: this row is the topmost thing in
                the window under the title bar, and upwards a tooltip covered the
                macOS traffic lights right beside it. */}
            <TooltipContent side="bottom">{label}</TooltipContent>
          </Tooltip>
        ))}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onCollapse}
              className="ml-auto flex items-center rounded-md p-1.5 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
            >
              <PanelLeftClose className="size-4" />
              <span className="sr-only">Hide sidebar</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Hide sidebar</TooltipContent>
        </Tooltip>
      </div>

      {/* The bound-worktree header applies to the worktree-scoped navigators;
          the Worktrees manager is repo-wide, so it has none. Files mode renders
          its own header INSIDE the ExplorerProvider (below) so the header's
          utility actions can drive the tree. */}
      {mode !== 'worktrees' && mode !== 'files' && (
        <SidebarTargetHeader sessions={sessions} target={sidebarTarget} location={locationPath} />
      )}

      {mode === 'worktrees' && (
        <WorktreesNav repoId={repoId} projectId={projectId} sessions={sessions} />
      )}

      {mode === 'files' &&
        (session && browseRoot !== null ? (
          // Browsing ABOVE the worktree, rooted at `browseRoot` (SPEC §8) — the
          // same explorer, given that root: BrowseTree mounts its own
          // ExplorerProvider so create/rename/delete/clipboard/DnD all work out
          // here too. Files opened from it are editors keyed by their root.
          <>
            <BrowseTree
              session={session}
              root={browseRoot}
              readOnly={!browseMutable}
              // Passed in rather than rendered here so it sits inside the
              // browse tree's provider and its Refresh · Collapse utilities
              // drive that tree (neither mutates, so `readOnly` keeps them).
              boundHeader={
                <SidebarTargetHeader
                  sessions={sessions}
                  target={sidebarTarget}
                  showFileActions
                  location={locationPath}
                />
              }
              onNavigateUp={() => enterBrowse(parentDir(browseRoot))}
              // Returning ends the directory browse AND the pin it created,
              // restoring normal follow-the-active-tab sidebar behaviour.
              onReset={sidebarTarget.unpin}
              onOpenFile={(path, opts) => onOpenExternalFile(session.id, path, browseRoot, opts)}
              activePath={activeExternalTab?.root === browseRoot ? activeExternalTab.path : null}
              compilableExtensions={compilableExtensions}
              onOpenCompilationSettings={onOpenCompilationSettings}
            />
          </>
        ) : session ? (
          // The provider wraps both the header (its utility actions) and the
          // tree; FileExplorer's root is `h-full`, so its wrapper is a flex-1
          // min-h-0 column filling the space under the icon row + header.
          <ExplorerProvider
            session={session}
            root={targetRoot}
            // A directory target's files are `external` tabs — the kind that
            // carries a root through the editor, its buffer, and its save;
            // a worktree's are ordinary file tabs, whose session names the root.
            onOpenFile={
              targetRoot === undefined
                ? onOpenFile
                : (sid, path, opts) => onOpenExternalFile(sid, path, targetRoot, opts)
            }
            compilableExtensions={compilableExtensions}
            onOpenCompilationSettings={onOpenCompilationSettings}
            // "Open Terminal in Directory" needs a worktree: the daemon confines
            // a terminal's cwd to one (11.1), and this target has no session.
            onOpenTerminal={
              targetRoot === undefined ? (dir) => onOpenTerminalIn(session.id, dir) : undefined
            }
            activePath={
              targetRoot === undefined
                ? activeFilePath
                : activeExternalTab?.root === targetRoot
                  ? activeExternalTab.path
                  : null
            }
          >
            <SidebarTargetHeader
              sessions={sessions}
              target={sidebarTarget}
              showFileActions
              location={locationPath}
            />
            {/* The way OUT of the worktree: '..' enters the browse tree at
                the parent, pinning the sidebar so the bound session cannot
                change underneath the browse (SPEC §8). */}
            {browseSupported && targetRoot === undefined && (
              <button
                type="button"
                onClick={() => enterBrowse(parentDir(session.worktree_path))}
                title="Browse the parent directory"
                className="flex shrink-0 items-center gap-1.5 px-3 py-1 text-left transition-colors hover:bg-elevated"
              >
                <CornerLeftUp className="size-3 shrink-0 text-fg-gold" />
                <span className="text-xs text-fg-muted">..</span>
              </button>
            )}
            <div className="flex min-h-0 flex-1 flex-col">
              <FileExplorer />
            </div>
          </ExplorerProvider>
        ) : (
          <>
            <SidebarTargetHeader
              sessions={sessions}
              target={sidebarTarget}
              location={locationPath}
            />
            <div className="px-3 py-2 text-xs text-fg-muted">No worktree to show.</div>
          </>
        ))}

      {mode === 'changes' &&
        (session ? (
          <ChangesNav
            key={navigatorScope}
            session={session.id}
            root={requestRoot}
            activeDiffPath={activeDiffPath}
            onOpenDiff={onOpenDiff}
            onOpenCommitFile={onOpenCommitFile}
          />
        ) : (
          <div className="px-3 py-2 text-xs text-fg-muted">No worktree to show.</div>
        ))}

      {mode === 'search' &&
        (session ? (
          <SearchNav
            key={navigatorScope}
            session={session.id}
            root={requestRoot}
            onOpen={(path, line, opts) => {
              onOpenSearchFile(path, line, opts);
              if (line === undefined) onModeChange('files');
            }}
          />
        ) : (
          <div className="px-3 py-2 text-xs text-fg-muted">No worktree to search.</div>
        ))}
    </div>
  );
}
