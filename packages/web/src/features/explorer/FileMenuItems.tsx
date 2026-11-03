import { ContextMenuItem, ContextMenuSeparator } from '../../components/ui/context-menu';
import { CLIENT_PLATFORM } from '../../lib/client-platform';
import { formatPrimaryShortcut } from '../../lib/navigation/hotkeys';
import { RevealInFileManagerItem } from './RevealInFileManagerItem';

// The explorer's fixed keys (not rebindable; its handler takes ⌘ or Ctrl),
// labelled in the client's notation: `⌥⌘C` on a Mac, `Ctrl+Alt+C` elsewhere.
const KEYS = {
  cut: formatPrimaryShortcut('meta+KeyX'),
  copy: formatPrimaryShortcut('meta+KeyC'),
  paste: formatPrimaryShortcut('meta+KeyV'),
  copyPath: formatPrimaryShortcut('alt+meta+KeyC'),
  copyRelativePath: formatPrimaryShortcut('alt+shift+meta+KeyC'),
  delete: CLIENT_PLATFORM === 'mac' ? '⌘⌫' : 'Delete',
};

/** A short right-aligned keyboard-shortcut hint inside a file menu row. */
export function Shortcut({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto pl-6 text-2xs text-fg-muted tabular-nums">{children}</span>;
}

/**
 * The actions shared by file-tree rows and path-backed editor tabs. Keeping the
 * rows here makes the two context menus one surface rather than two copies that
 * gradually acquire different labels, ordering, or shortcut hints.
 */
export function FileMenuItems({
  absolutePath,
  readOnly,
  canPaste,
  onCut,
  onCopy,
  onPaste,
  onCopyPath,
  onCopyRelativePath,
  onReveal,
  onCompilationSettings,
  onRename,
  onDelete,
  onDownload,
}: {
  absolutePath: string;
  readOnly: boolean;
  canPaste: boolean;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
  /** Tab-only: the tree row is already revealed by definition. */
  onReveal?: () => void;
  /** Compilable-file-only: edit this file's project-scoped command slots. */
  onCompilationSettings?: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDownload: () => void;
}) {
  return (
    <>
      {!readOnly && (
        <>
          <ContextMenuItem onSelect={onCut}>
            Cut <Shortcut>{KEYS.cut}</Shortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={onCopy}>
            Copy <Shortcut>{KEYS.copy}</Shortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled={!canPaste} onSelect={onPaste}>
            Paste <Shortcut>{KEYS.paste}</Shortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem onSelect={onCopyPath}>
        Copy Path <Shortcut>{KEYS.copyPath}</Shortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={onCopyRelativePath}>
        Copy Relative Path <Shortcut>{KEYS.copyRelativePath}</Shortcut>
      </ContextMenuItem>
      {onReveal && <ContextMenuItem onSelect={onReveal}>Reveal in Filetree</ContextMenuItem>}
      <RevealInFileManagerItem path={absolutePath} />
      {onCompilationSettings && (
        <ContextMenuItem onSelect={onCompilationSettings}>Compilation Settings…</ContextMenuItem>
      )}
      <ContextMenuSeparator />
      {!readOnly && (
        <>
          <ContextMenuItem onSelect={onRename}>
            Rename… <Shortcut>F2</Shortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={onDelete}>
            Delete <Shortcut>{KEYS.delete}</Shortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem onSelect={onDownload}>Download</ContextMenuItem>
    </>
  );
}
