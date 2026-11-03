import { useEffect, useRef } from 'react';
import { Button } from '../../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { useHostInfo } from '../../lib/queries/queries';
import { tildify } from '../../lib/tildify';
import { cn } from '../../lib/utils';
import { useExplorer } from './explorer-context';
import { basename, decodeDragPaths, EXPLORER_DRAG_MIME } from './explorer-paths';
import { DirEntries } from './TreeNode';
import { RevealInFileManagerItem } from './RevealInFileManagerItem';

/**
 * File explorer for one directory tree (SPEC §8): a VSCode-grade tree with git
 * decorations, rich context menus, a cut/copy/paste clipboard, multi-select and
 * arrow-key navigation, and inline create/rename. State lives in the
 * surrounding `ExplorerProvider` (shared with the header's utility actions in
 * `NavigatorSidebar`); this renders the scroll surface, keyboard host,
 * empty-space menu, and the single delete confirmation.
 *
 * The provider's root decides WHICH tree: the session's worktree, or — when
 * browsing above it — a parent directory. This surface is identical either way;
 * only `readOnly` (an old daemon out there, see `ExplorerCtx`) thins the menus.
 */
export function FileExplorer() {
  return (
    <>
      <ExplorerBody />
      <DeleteDialog />
    </>
  );
}

function ExplorerBody() {
  const ex = useExplorer();
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the keyboard-focused row scrolled into view during arrow navigation.
  useEffect(() => {
    if (!ex.focusedPath || !rootRef.current) return;
    const el = rootRef.current.querySelector(`[data-path="${CSS.escape(ex.focusedPath)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [ex.focusedPath]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rootRef}
          data-explorer-root
          role="tree"
          tabIndex={0}
          onKeyDown={ex.handleKeyDown}
          onPaste={(e) => {
            if (ex.onClipboardPaste(e.clipboardData.items, e.clipboardData.files)) {
              e.preventDefault();
            }
          }}
          onDragOver={(e) => {
            if (ex.readOnly) return;
            e.preventDefault();
            ex.setDropTarget('');
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) ex.setDropTarget(null);
          }}
          onDrop={(e) => {
            if (ex.readOnly) return;
            e.preventDefault();
            ex.setDropTarget(null);
            const dragged = decodeDragPaths(e.dataTransfer.getData(EXPLORER_DRAG_MIME));
            if (dragged.length > 0) ex.onInternalDrop('', dragged);
            else ex.onDropUpload('', e.dataTransfer.items, e.dataTransfer.files);
          }}
          // Leave 2.5 row heights inside the scroll surface for the root menu,
          // including when a long tree fills the viewport (rows are h-6/h-5).
          className={cn(
            'h-full overflow-y-auto pb-15 pt-1 outline-none compact:pb-12.5',
            ex.dropTarget === '' && 'bg-selection',
          )}
        >
          <DirEntries sid={ex.sid} path="" depth={0} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        // New File…/New Folder… mount an inline edit input; without this the
        // menu's close-auto-focus steals focus back to the tree, so typing
        // straight after creating would not name the entry.
        onCloseAutoFocus={(e) => {
          if (ex.editing) e.preventDefault();
        }}
      >
        {!ex.readOnly && (
          <>
            <ContextMenuItem onSelect={() => ex.beginCreate('', 'file')}>New File…</ContextMenuItem>
            <ContextMenuItem onSelect={() => ex.beginCreate('', 'dir')}>
              New Folder…
            </ContextMenuItem>
            {ex.onOpenTerminal && (
              <ContextMenuItem onSelect={() => ex.onOpenTerminal?.('')}>
                Open Terminal in Directory
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!ex.canPaste} onSelect={() => ex.paste('')}>
              Paste
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={() => ex.copyPathToClipboard([''], false)}>
          Copy Path
        </ContextMenuItem>
        <RevealInFileManagerItem path={ex.rootPath} />
        {/* Names what it will actually zip: the worktree, or the directory
            being browsed above it. */}
        <ContextMenuItem onSelect={() => ex.download([''])}>
          Download {basename(ex.rootPath) || 'folder'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The single, provider-owned delete confirmation (deletion is irreversible — no host trash). */
function DeleteDialog() {
  const ex = useExplorer();
  const home = useHostInfo().data?.home;
  const paths = ex.pendingDelete;
  const open = paths !== null;
  const label =
    paths && paths.length === 1 ? `“${basename(paths[0]!)}”` : `${paths?.length ?? 0} items`;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && ex.cancelDelete()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {label}?</DialogTitle>
          {/* Names the directory it will vanish from — under a browse root that
              is not the worktree, and saying "the worktree" would be a lie. */}
          <DialogDescription>
            This permanently removes {paths && paths.length > 1 ? 'them' : 'it'} from{' '}
            <span className="text-fg-secondary">{tildify(ex.rootPath, home)}</span>. There is no
            undo.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={ex.cancelDelete}>
            Cancel
          </Button>
          <Button variant="danger" onClick={ex.confirmDelete}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
