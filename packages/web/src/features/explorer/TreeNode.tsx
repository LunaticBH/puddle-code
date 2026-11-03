import { useEffect, useRef, useState } from 'react';
import { ChevronRight, FolderClosed, FolderOpen, Link2 } from 'lucide-react';
import type { TreeEntry } from '@puddle/shared';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { HoverMarquee } from '../../components/hover-marquee';
import { cn } from '../../lib/utils';
import { useWorktreeTree } from '../../lib/queries/worktree-queries';
import { encodeTabTransfer, TAB_MIME } from '../workspace/tabs/tab-transfer';
import { isCompilableSource } from '../editor/compilation/compilation-kind';
import { useExplorer } from './explorer-context';
import {
  decodeDragPaths,
  dirOf,
  encodeDragPaths,
  EXPLORER_DRAG_MIME,
  joinAbsolutePath,
  joinPath,
  pruneNested,
  type VisibleRow,
} from './explorer-paths';
import { FileTypeIcon } from './file-icons';
import { FileMenuItems } from './FileMenuItems';
import { folderStatus, gitDecoration } from './git-decoration';

const INDENT_PX = 14;

// A clipped name eases into view on ITS OWN row's hover, at the app's one
// marquee speed — the treatment every other sidebar list already gives clipped
// text. It replaced a native `title` on directory rows (v0.0.28), which
// Chromium never shows on a draggable element, so the tooltip simply did not
// appear (fixed 2026-08-06). Named group: the row must not govern any future
// group-hover styling inside it. Literal so Tailwind generates it.
const ROW_MARQUEE = 'group-hover/treerow:[transform:translateX(var(--tail))]';

/**
 * VSCode-style drag image for a multi-item drag: a small "N items" chip (the
 * browser default would show only the grabbed row). Parked off-screen for the
 * snapshot and removed on the next frame.
 */
function setCountDragImage(e: React.DragEvent, count: number) {
  const chip = document.createElement('div');
  chip.textContent = `${count} items`;
  chip.className = 'fixed -top-12 left-0 rounded-md bg-elevated px-2 py-1 text-xs text-fg';
  document.body.appendChild(chip);
  e.dataTransfer.setDragImage(chip, 12, 12);
  requestAnimationFrame(() => chip.remove());
}

/** The inline text input used for both rename and new-entry creation (VSCode-style, no dialog). */
function EditRow({
  depth,
  initial,
  icon,
  onCommit,
  onCancel,
}: {
  depth: number;
  initial: string;
  icon: React.ReactNode;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const claim = () => {
      el.focus();
      // Select the basename, not the extension (matches VSCode rename).
      const dot = initial.lastIndexOf('.');
      el.setSelectionRange(0, dot > 0 ? dot : initial.length);
    };
    claim();
    // The context menu that summoned this row steals focus back to its trigger
    // as it closes (its onCloseAutoFocus is prevented while editing, but any
    // other same-tick focus juggling would too) — re-claim on the next frame
    // so typing straight away always lands in the input.
    const raf = requestAnimationFrame(() => {
      if (document.activeElement !== el) claim();
    });
    return () => cancelAnimationFrame(raf);
  }, [initial]);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(ref.current?.value ?? '');
  };
  return (
    <div
      className="flex h-6 items-center gap-1 pr-2 compact:h-5"
      style={{ paddingLeft: depth * INDENT_PX + 8 }}
    >
      <span className="size-3.5 shrink-0" />
      {icon}
      <input
        ref={ref}
        defaultValue={initial}
        spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') {
            done.current = true;
            onCancel();
          }
        }}
        onBlur={commit}
        className="min-w-0 flex-1 bg-surface text-sm text-fg outline-none"
      />
    </div>
  );
}

/** One explorer row; a directory recurses into `DirEntries` for its children when expanded (SPEC §8). */
export function TreeNode({
  path,
  entry,
  depth,
}: {
  path: string;
  entry: TreeEntry;
  depth: number;
}) {
  const ex = useExplorer();
  const isDir = entry.type === 'dir';
  const isOpen = isDir && ex.expanded.has(path);
  const isDropTarget = isDir && ex.dropTarget === path;
  const isActive = !isDir && path === ex.activePath;
  const isSelected = ex.selection.has(path);
  const isCut = ex.isCut(path);
  const row: VisibleRow = {
    path,
    name: entry.name,
    type: entry.type,
    depth,
    parentDir: dirOf(path),
  };

  const status = ex.statusMap.get(path);
  const folderTint = isDir ? folderStatus(ex.statusMap, path) : null;
  const decoration = status ? gitDecoration(status) : folderTint ? gitDecoration(folderTint) : null;
  const nameColour = decoration
    ? decoration.colourClass
    : entry.name.startsWith('.')
      ? 'text-fg-muted'
      : 'text-fg';

  // The paste target and the entries a menu action operates on (respect a
  // multi-selection that includes this row; otherwise just this row).
  const targets = isSelected && ex.selection.size > 1 ? [...ex.selection] : [path];
  const pasteDir = isDir ? path : dirOf(path);
  const editingHere = ex.editing?.mode === 'rename' && ex.editing.path === path;
  const compilationSource =
    !isDir &&
    ex.onOpenCompilationSettings !== undefined &&
    isCompilableSource(path, ex.compilableExtensions)
      ? {
          session: ex.sid,
          path,
          ...(ex.root !== undefined ? { root: ex.root } : {}),
        }
      : null;

  if (editingHere) {
    return (
      <EditRow
        depth={depth}
        initial={entry.name}
        icon={
          isDir ? (
            <FolderClosed className="size-3.5 shrink-0 text-fg" />
          ) : (
            <FileTypeIcon name={entry.name} />
          )
        }
        onCommit={ex.commitEdit}
        onCancel={ex.cancelEdit}
      />
    );
  }

  const rowEl = (
    <div
      role="treeitem"
      data-path={path}
      aria-expanded={isDir ? isOpen : undefined}
      aria-selected={isSelected}
      tabIndex={-1}
      // A read-only tree has nowhere to drop, so it is no drag source either.
      draggable={!ex.readOnly}
      onClick={(e) => {
        (e.currentTarget.closest('[data-explorer-root]') as HTMLElement | null)?.focus();
        ex.onRowClick(row, e);
      }}
      onDoubleClick={() => ex.onRowDoubleClick(row)}
      onContextMenu={() => {
        // Right-clicking a row outside the selection selects just it first
        // (without toggling/opening it, unlike a plain click).
        if (!isSelected) ex.selectOnly(path);
      }}
      onDragStart={(e) => {
        // Dragging a selected row drags the whole selection (nested paths
        // pruned — moving the parent moves them); an unselected row drags alone.
        const dragPaths = pruneNested(targets);
        e.dataTransfer.setData(EXPLORER_DRAG_MIME, encodeDragPaths(dragPaths));
        if (dragPaths.length > 1) setCountDragImage(e, dragPaths.length);
        // A single file row is also draggable into the centre tiling area,
        // where the drop opens it as a permanent, positioned editor tab (SPEC §8).
        // Above the worktree it must be an `external` tab carrying the browse
        // root — a `file` tab would resolve this root-relative path against the
        // WORKTREE and open a different file, or none.
        if (!isDir && dragPaths.length === 1) {
          e.dataTransfer.setData(
            TAB_MIME,
            encodeTabTransfer({
              type: 'editor',
              tab:
                ex.root === undefined
                  ? { kind: 'file', session: ex.sid, path }
                  : { kind: 'external', session: ex.sid, path, root: ex.root },
            }),
          );
        }
        e.dataTransfer.effectAllowed = 'copyMove';
      }}
      onDragOver={(e) => {
        if (!isDir || ex.readOnly) return;
        e.preventDefault();
        e.stopPropagation();
        ex.setDropTarget(path);
      }}
      onDragLeave={(e) => {
        if (isDir && e.currentTarget === e.target) ex.setDropTarget(null);
      }}
      onDrop={(e) => {
        if (!isDir || ex.readOnly) return;
        e.preventDefault();
        e.stopPropagation();
        ex.setDropTarget(null);
        const dragged = decodeDragPaths(e.dataTransfer.getData(EXPLORER_DRAG_MIME));
        if (dragged.length > 0) ex.onInternalDrop(path, dragged);
        else ex.onDropUpload(path, e.dataTransfer.items, e.dataTransfer.files);
      }}
      style={{ paddingLeft: depth * INDENT_PX + 8 }}
      className={cn(
        'group/treerow flex h-6 cursor-pointer items-center gap-1 pr-2 text-sm transition-colors hover:bg-elevated compact:h-5',
        isSelected ? 'bg-selection' : isActive && 'bg-elevated',
        isDropTarget && 'bg-selection',
        isCut && 'opacity-50',
      )}
    >
      {isDir ? (
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-fg-gold transition-transform duration-150',
            isOpen && 'rotate-90',
          )}
        />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      {/* Untinted icons wear the heading colour (text-fg), never gold — colour
          on a tree icon means git status (a gold default read as "modified").
          The link icon marks the symlink ROOT and wins over the folder glyph,
          so a symlinked directory reads as a link while its (normal) children
          keep their own icons; the chevron above still makes it explorable. */}
      {entry.symlink || entry.type === 'symlink' ? (
        <Link2 className="size-3.5 shrink-0 text-fg" />
      ) : isDir ? (
        isOpen ? (
          <FolderOpen
            className={cn('size-3.5 shrink-0', folderTint ? decoration?.colourClass : 'text-fg')}
          />
        ) : (
          <FolderClosed
            className={cn('size-3.5 shrink-0', folderTint ? decoration?.colourClass : 'text-fg')}
          />
        )
      ) : (
        <FileTypeIcon name={entry.name} dimmed={status === 'ignored'} />
      )}
      <HoverMarquee text={entry.name} className={nameColour} hoverClass={ROW_MARQUEE} />
      {status && decoration && decoration.letter && (
        <span className={cn('shrink-0 font-mono text-2xs', decoration.colourClass)}>
          {decoration.letter}
        </span>
      )}
    </div>
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{rowEl}</ContextMenuTrigger>
        <ContextMenuContent
          // New File…/New Folder…/Rename… mount an inline edit input; the
          // menu's default close-auto-focus would steal focus back to this
          // row, so typing straight after creating would go nowhere.
          onCloseAutoFocus={(e) => {
            if (ex.editing) e.preventDefault();
          }}
        >
          {isDir && !ex.readOnly && (
            <>
              <ContextMenuItem onSelect={() => ex.beginCreate(path, 'file')}>
                New File…
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => ex.beginCreate(path, 'dir')}>
                New Folder…
              </ContextMenuItem>
              {ex.onOpenTerminal && (
                <ContextMenuItem onSelect={() => ex.onOpenTerminal?.(path)}>
                  Open Terminal in Directory
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
            </>
          )}
          <FileMenuItems
            absolutePath={joinAbsolutePath(ex.rootPath, path)}
            readOnly={ex.readOnly}
            canPaste={ex.canPaste}
            onCut={() => ex.cut(targets)}
            onCopy={() => ex.copy(targets)}
            onPaste={() => ex.paste(pasteDir)}
            onCopyPath={() => ex.copyPathToClipboard(targets, false)}
            onCopyRelativePath={() => ex.copyPathToClipboard(targets, true)}
            onCompilationSettings={
              compilationSource
                ? () => ex.onOpenCompilationSettings?.(compilationSource)
                : undefined
            }
            onRename={() => ex.beginRename(path)}
            onDelete={() => ex.requestDelete(targets)}
            onDownload={() => ex.download(targets)}
          />
        </ContextMenuContent>
      </ContextMenu>
      {isDir && isOpen && <DirEntries sid={ex.sid} path={path} depth={depth + 1} />}
    </>
  );
}

/** A directory's children: mounts its own `useWorktreeTree` and renders a `TreeNode` per entry. */
export function DirEntries({ sid, path, depth }: { sid: string; path: string; depth: number }) {
  const ex = useExplorer();
  // `ex.root` is undefined in the worktree and the browse root above it, so one
  // tree serves both (SPEC §8) — the query key follows suit.
  const tree = useWorktreeTree(sid, path, ex.root);
  const pad = { paddingLeft: depth * INDENT_PX + 8 };

  const editing = ex.editing;
  const createRow =
    editing?.mode === 'create' && editing.parentDir === path ? (
      <CreateRow depth={depth} kind={editing.kind} />
    ) : null;

  if (tree.isLoading) {
    return (
      <>
        {createRow}
        <div style={pad} className="py-0.5 text-xs text-fg-muted">
          Loading…
        </div>
      </>
    );
  }
  if (tree.isError) {
    return (
      <div style={pad} className="py-0.5 text-xs text-fg-muted">
        {tree.error instanceof Error ? tree.error.message : "Couldn't load this folder."}
      </div>
    );
  }
  const entries = tree.data?.entries ?? [];
  if (entries.length === 0 && !createRow) {
    return (
      <div style={pad} className="py-0.5 text-xs text-fg-muted">
        Empty
      </div>
    );
  }
  return (
    <>
      {createRow}
      {entries.map((entry) => (
        <TreeNode key={entry.name} path={joinPath(path, entry.name)} entry={entry} depth={depth} />
      ))}
    </>
  );
}

/** The pending new-file/new-folder input row under its parent directory. */
function CreateRow({ depth, kind }: { depth: number; kind: 'file' | 'dir' }) {
  const ex = useExplorer();
  const [name, setName] = useState('');
  return (
    <EditRow
      depth={depth}
      initial={name}
      icon={
        kind === 'dir' ? (
          <FolderClosed className="size-3.5 shrink-0 text-fg" />
        ) : (
          <FileTypeIcon name={name || 'file'} />
        )
      }
      onCommit={(value) => {
        setName(value);
        ex.commitEdit(value);
      }}
      onCancel={ex.cancelEdit}
    />
  );
}
