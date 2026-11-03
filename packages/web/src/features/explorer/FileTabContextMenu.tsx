import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { EditorTab } from '../editor/tabs/editor-tabs';
import { Button } from '../../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
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
import { useDaemonVersion, useHostInfo } from '../../lib/queries/queries';
import {
  browseMutationsSupported,
  crossFiletreeTransferSupported,
} from '../../lib/transport/protocol-support';
import { downloadPath } from '../../lib/queries/worktree-queries';
import {
  confirmedSameDaemonHost,
  finishExplorerCut,
  hostIdentity,
  sameDaemonHost,
  sameFiletree,
  setExplorerClipboard,
  useExplorerClipboard,
  type ExplorerClipboardTarget,
} from './clipboard-store';
import { basename, dirOf, joinAbsolutePath } from './explorer-paths';
import { FileMenuItems } from './FileMenuItems';
import { useExplorerFs } from './use-explorer-fs';

/**
 * A path-backed editor tab's file-tree menu. It deliberately uses the same menu
 * rows, clipboard, fs operations, protocol gates, and confirmations as a tree
 * row. Rename opens the tab chip's own inline editor.
 */
export function FileTabContextMenu({
  tab,
  directory,
  onReveal,
  onCompilationSettings,
  onRename,
  editing,
  children,
}: {
  tab: EditorTab;
  /** Absolute root `tab.path` is relative to (worktree path or external root). */
  directory: string;
  onReveal: () => void;
  onCompilationSettings?: () => void;
  onRename: () => void;
  /** Prevent Radix returning focus to the chip while its rename input mounts. */
  editing?: boolean;
  children: ReactNode;
}) {
  const host = useHostInfo();
  const protocol = useDaemonVersion().data?.protocol;
  const clipboard = useExplorerClipboard();
  const fs = useExplorerFs(tab.session, tab.root, directory);
  const target = useMemo<ExplorerClipboardTarget>(
    () => ({
      sid: tab.session,
      root: tab.root,
      directory,
      host: hostIdentity(host.data),
    }),
    [tab.session, tab.root, directory, host.data],
  );
  const readOnly = tab.root !== undefined && !browseMutationsSupported(protocol);
  const sameHost = clipboard !== null && sameDaemonHost(clipboard.source, target);
  const sameTree = clipboard !== null && sameFiletree(clipboard.source, target);
  const canPaste =
    !readOnly &&
    ((sameHost && sameTree) ||
      (clipboard !== null &&
        confirmedSameDaemonHost(clipboard.source, target) &&
        crossFiletreeTransferSupported(protocol)));
  const [deleting, setDeleting] = useState(false);
  const absolutePath = joinAbsolutePath(directory, tab.path);

  const paste = () => {
    if (!clipboard || !canPaste) return;
    void fs.paste(clipboard, dirOf(tab.path)).then((failedPaths) => {
      if (clipboard.mode === 'cut') finishExplorerCut(clipboard.id, failedPaths);
    });
  };
  const copyPath = (relative: boolean) => {
    void navigator.clipboard.writeText(relative ? tab.path : absolutePath);
    toast.success(relative ? 'Relative path copied' : 'Path copied');
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(event) => {
            if (editing) event.preventDefault();
          }}
        >
          <FileMenuItems
            absolutePath={absolutePath}
            readOnly={readOnly}
            canPaste={canPaste}
            onCut={() => setExplorerClipboard([tab.path], 'cut', target)}
            onCopy={() => setExplorerClipboard([tab.path], 'copy', target)}
            onPaste={paste}
            onCopyPath={() => copyPath(false)}
            onCopyRelativePath={() => copyPath(true)}
            onReveal={onReveal}
            onCompilationSettings={onCompilationSettings}
            onRename={onRename}
            onDelete={() => setDeleting(true)}
            onDownload={() => {
              void downloadPath(tab.session, tab.path, tab.root).catch((e: unknown) =>
                toast.error(e instanceof Error ? e.message : 'Download failed'),
              );
            }}
          />
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{basename(tab.path)}”?</DialogTitle>
            <DialogDescription>
              This permanently removes it from {directory}. There is no undo.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setDeleting(false);
                void fs.remove([tab.path]);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
