import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CompilationFileTarget, GitStatus, Session, TreeResponse } from '@puddle/shared';
import { hostNameProblem, hostStyleForPlatform, sameHostPath } from '../../lib/host-path';
import { useDaemonVersion, useHostInfo } from '../../lib/queries/queries';
import { windowsRefusalMessage } from '../../lib/transport/windows-refusals';
import { clearPendingReveal, onReveal } from '../../lib/navigation/reveal-in-tree';
import { isSecondClick, type ClickStamp } from '../../lib/second-click';
import {
  downloadPath,
  uploadFiles,
  useWorktreeGitStatus,
} from '../../lib/queries/worktree-queries';
import {
  crossFiletreeTransferSupported,
  sourceControlSupported,
} from '../../lib/transport/protocol-support';
import {
  confirmedSameDaemonHost,
  finishExplorerCut,
  hostIdentity,
  sameDaemonHost,
  sameFiletree,
  setExplorerClipboard,
  useExplorerClipboard,
  type ExplorerClipboardState,
  type ExplorerClipboardTarget,
} from './clipboard-store';
import { collectDroppedFiles, collectPastedFiles, hasPastedFiles } from './drop-files';
import { buildStatusMap } from './git-decoration';
import {
  ancestorDirs,
  basename,
  buildVisibleRows,
  copyablePath,
  pruneNested,
  rangeBetween,
  type VisibleRow,
} from './explorer-paths';
import { canMoveInto, useExplorerFs } from './use-explorer-fs';

/** An in-flight inline edit: renaming an existing row, or naming a new entry under a folder. */
export type EditingState =
  { mode: 'rename'; path: string } | { mode: 'create'; parentDir: string; kind: 'file' | 'dir' };

/** Everything a tree row and the header need, provided once by `ExplorerProvider`. */
export interface ExplorerCtx {
  sid: string;
  /**
   * Absolute path every row is relative to: the session's worktree, or the
   * browse `root` when the tree is showing a directory above it (SPEC §8).
   */
  rootPath: string;
  /**
   * The `?root=` override to send with every request, or undefined in the
   * worktree (where the session id alone names the root). Tree rows pass it
   * to their own queries; `useExplorerFs` sends it with each mutation.
   */
  root: string | undefined;
  /**
   * No mutations offered: the menus drop create/rename/delete/clipboard, rows
   * stop being drag sources, and drops stop uploading. Set when browsing above
   * the worktree against a daemon older than protocol 12.3, which would resolve
   * those paths against the WORKTREE and silently touch the wrong files.
   */
  readOnly: boolean;
  onOpenFile?: (sid: string, path: string, opts?: { preview?: boolean }) => void;
  /** Spawn a terminal whose shell starts in this worktree-relative directory. */
  onOpenTerminal?: (dir: string) => void;
  activePath: string | null;
  /** Extensions currently claimed by available daemon compilation providers. */
  compilableExtensions: ReadonlySet<string>;
  onOpenCompilationSettings?: (source: CompilationFileTarget) => void;

  expanded: ReadonlySet<string>;
  toggle(path: string): void;
  collapseAll(): void;

  statusMap: ReadonlyMap<string, GitStatus>;
  visibleRows: VisibleRow[];

  selection: ReadonlySet<string>;
  focusedPath: string | null;
  onRowClick(
    row: VisibleRow,
    /** `detail` is the click count — 2 marks a double-click's second click. */
    e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; detail?: number },
  ): void;
  /** Double-click a file row: promote its preview tab to a permanent one (VSCode-style). */
  onRowDoubleClick(row: VisibleRow): void;
  /** Select a single row without activating it (right-click, before a context menu). */
  selectOnly(path: string): void;

  clipboard: ExplorerClipboardState | null;
  canPaste: boolean;
  isCut(path: string): boolean;
  cut(paths: string[]): void;
  copy(paths: string[]): void;
  paste(targetDir: string): void;

  editing: EditingState | null;
  beginRename(path: string): void;
  beginCreate(parentDir: string, kind: 'file' | 'dir'): void;
  cancelEdit(): void;
  commitEdit(name: string): void;
  /** Why the host cannot store a typed name (Windows rules), or null; checked before committing. */
  nameProblem(name: string): string | null;

  requestDelete(paths: string[]): void;
  /** Copy the given paths (absolute or worktree-relative), one per line. */
  copyPathToClipboard(paths: string[], relative: boolean): void;
  /** Download each path in turn (a directory arrives as a zip). */
  download(paths: string[]): void;
  refresh(): void;

  onUpload(dir: string, files: File[]): void;
  /**
   * OS drop into `dir`: resolves the DataTransfer — walking dropped folders
   * when the daemon supports them — then uploads. Call it synchronously from
   * the event handler (the DataTransfer is only readable during dispatch).
   */
  onDropUpload(dir: string, items: DataTransferItemList | undefined, files: FileList): void;
  /** Upload native clipboard files, or fall back to the internal cut/copy clipboard. */
  onClipboardPaste(items: DataTransferItemList | undefined, files: FileList): boolean;
  dropTarget: string | null;
  setDropTarget(path: string | null): void;
  onInternalDrop(targetDir: string, draggedPaths: string[]): void;

  handleKeyDown(e: ReactKeyboardEvent): void;

  /** Delete-confirmation state, rendered by the provider's dialog. */
  pendingDelete: string[] | null;
  confirmDelete(): void;
  cancelDelete(): void;
}

const Ctx = createContext<ExplorerCtx | null>(null);

export function useExplorer(): ExplorerCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('explorer components must render inside <ExplorerProvider>');
  return ctx;
}

/** Optional variant for shared chrome (e.g. the header) that may render outside files mode. */
export function useExplorerOptional(): ExplorerCtx | null {
  return useContext(Ctx);
}

export function ExplorerProvider({
  session,
  root,
  readOnly = false,
  onOpenFile,
  onOpenTerminal,
  compilableExtensions,
  onOpenCompilationSettings,
  activePath,
  children,
}: {
  session: Session;
  /**
   * Browse a directory ABOVE the session's worktree instead of the worktree
   * itself (SPEC §8): every row, query, and mutation is resolved against this
   * absolute path via `?root=`. Omit it for the worktree.
   */
  root?: string;
  /** Offer no mutations — see `ExplorerCtx.readOnly`. */
  readOnly?: boolean;
  onOpenFile?: (sid: string, path: string, opts?: { preview?: boolean }) => void;
  onOpenTerminal?: (dir: string) => void;
  compilableExtensions: ReadonlySet<string>;
  onOpenCompilationSettings?: (source: CompilationFileTarget) => void;
  activePath: string | null;
  children: React.ReactNode;
}) {
  const sid = session.id;
  const qc = useQueryClient();
  const rootPath = root ?? session.worktree_path;
  const fs = useExplorerFs(sid, root, rootPath);

  // Every tree query is keyed by root when one is set, matching
  // `useWorktreeTree` — so a browse of `/Users/me` and the worktree tree can be
  // cached side by side without either serving the other's rows.
  const treeKey = useCallback(
    (dir: string) => (root === undefined ? ['wt-tree', sid, dir] : ['wt-tree', sid, dir, root]),
    [sid, root],
  );

  const onUpload = useCallback(
    (dir: string, files: File[]) => {
      if (files.length === 0 || readOnly) return;
      uploadFiles(sid, dir, files, root)
        .then(() => {
          void qc.invalidateQueries({ queryKey: treeKey(dir) });
          void qc.invalidateQueries({ queryKey: ['wt-git-status', sid] });
          toast.success(
            files.length === 1 ? `Uploaded ${files[0]!.name}` : `Uploaded ${files.length} files`,
          );
        })
        .catch((e: unknown) =>
          toast.error(
            windowsRefusalMessage(e) ?? (e instanceof Error ? e.message : 'Upload failed'),
          ),
        );
    },
    [sid, root, readOnly, qc, treeKey],
  );

  // Folder drops need the daemon to honour relative upload paths (9.2); on an
  // older daemon collectDroppedFiles falls back to rejecting folders. Unknown
  // (still fetching) reads as supported — version skew within a major is rare.
  const version = useDaemonVersion();
  const protocol = version.data?.protocol;
  const host = useHostInfo();
  const hostStyle = hostStyleForPlatform(host.data?.platform);
  const nameProblem = useCallback(
    (name: string) => hostNameProblem(name.trim(), hostStyle),
    [hostStyle],
  );
  const target = useMemo<ExplorerClipboardTarget>(
    () => ({ sid, root, directory: rootPath, host: hostIdentity(host.data) }),
    [sid, root, rootPath, host.data],
  );
  const foldersSupported =
    !protocol || protocol.major > 9 || (protocol.major === 9 && protocol.minor >= 2);

  const onDropUpload = useCallback(
    (dir: string, items: DataTransferItemList | undefined, files: FileList) => {
      collectDroppedFiles(items, files, foldersSupported)
        .then((collected) => onUpload(dir, collected))
        .catch((e: unknown) =>
          toast.error(e instanceof Error ? e.message : "Couldn't read the dropped folder"),
        );
    },
    [onUpload, foldersSupported],
  );

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const clipboard = useExplorerClipboard();
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  const anchorRef = useRef<string | null>(null);

  // A drag released outside the tree — over a pane, over nothing, or cancelled
  // with Esc — fires no `dragleave` on the row it was last over, which left that
  // row highlighted for good. `dragend` fires on the source for every outcome,
  // so it is the one signal that always disarms the highlight.
  useEffect(() => {
    const clear = () => setDropTarget(null);
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);

  // Protocol 15.3 rebases every owning/nested repository to the visible root,
  // so project and parent-directory targets get honest decorations too. Older
  // daemons retain the worktree-only request to avoid coincidental path matches.
  const statusQuery = useWorktreeGitStatus(sid, {
    root,
    enabled: root === undefined || (protocol !== undefined && sourceControlSupported(protocol)),
  });
  const statusMap = useMemo(
    () => buildStatusMap(statusQuery.data?.entries ?? []),
    [statusQuery.data],
  );
  const refetchStatus = statusQuery.refetch;

  // Recompute the flat visible-row list whenever the expansion set changes or a
  // directory's tree query lands (subscribe to the cache for the latter).
  const [rowsVersion, setRowsVersion] = useState(0);
  useEffect(() => {
    const unsub = qc.getQueryCache().subscribe((event) => {
      // Only query-state events can change what `getQueryData` returns. The
      // observer* events fire during React renders themselves (`useQuery`
      // re-emits `observerOptionsUpdated` on every render because its inline
      // `queryFn` defeats the shallow options comparison) — bumping state on
      // those turns render → event → bump → render into a busy-loop that pins
      // a core for as long as the explorer is mounted.
      if (event.type !== 'added' && event.type !== 'removed' && event.type !== 'updated') return;
      const key = event.query.queryKey;
      if (Array.isArray(key) && key[0] === 'wt-tree' && key[1] === sid) {
        setRowsVersion((v) => v + 1);
      }
    });
    return unsub;
  }, [qc, sid]);
  const visibleRows = useMemo(
    () => buildVisibleRows((dir) => qc.getQueryData<TreeResponse>(treeKey(dir)), expanded),
    // rowsVersion invalidates the memo when cache data changes under the same key set.
    [qc, treeKey, expanded, rowsVersion],
  );

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const expand = useCallback((path: string) => {
    setExpanded((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
  }, []);
  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  // "Reveal in Files": a path clicked in ANOTHER navigator (a search hit, a
  // changed file) expands its ancestors, selects its row, and scrolls it into
  // view. The request is a latch (`lib/reveal-in-tree`), so one made while this
  // tree was unmounted — the left sidebar shows one navigator at a time — is
  // honoured the moment the tree appears. A request for a different `root` is
  // another tree's business: the same relative path means a different file there.
  const [revealing, setRevealing] = useState<string | null>(null);
  useEffect(
    () =>
      onReveal((request) => {
        if (
          request.directory !== undefined
            ? !sameHostPath(request.directory, rootPath)
            : request.root !== root
        )
          return;
        clearPendingReveal();
        for (const dir of ancestorDirs(request.path)) expand(dir);
        if (request.expandTarget && request.path !== '') expand(request.path);
        setSelection(new Set([request.path]));
        setFocusedPath(request.path);
        if (request.renameTarget && !readOnly) setEditing({ mode: 'rename', path: request.path });
        setRevealing(request.path);
      }),
    [root, rootPath, expand, readOnly],
  );
  // The row cannot be scrolled to until it EXISTS: each newly expanded directory
  // fetches its children, so the run of `visibleRows` changes is what this waits
  // on. It gives up a few seconds after the tree stops changing rather than
  // watching forever for a path that has since been deleted or renamed.
  useEffect(() => {
    if (revealing === null) return;
    const row = document.querySelector(
      `[data-explorer-root] [data-path="${CSS.escape(revealing)}"]`,
    );
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      setRevealing(null);
      return;
    }
    const id = window.setTimeout(() => setRevealing(null), 4000);
    return () => window.clearTimeout(id);
  }, [revealing, visibleRows]);

  // Click-to-rename, FILES ONLY (SPEC §8). A plain click on the sole-selected
  // file row, when the previous click on it was recent (`isSecondClick`), starts
  // an inline rename after a beat — so the second click of a double-click (which
  // pins the file instead) can cancel it. Any other click cancels a pending
  // rename first: the timer must never fire for a row the user has moved on from.
  //
  // FOLDERS have no click gesture for renaming at all (decision 2026-08-04): a
  // folder's clicks belong to expand/collapse, and every variant tried fought
  // that — the second-click timer fired mid-toggle, and moving it to
  // double-click meant flipping a folder open and shut quickly opened a rename
  // box. The context menu's Rename… (and F2) is the whole story for a folder.
  const renameTimer = useRef<number | null>(null);
  const lastRowClick = useRef<ClickStamp | null>(null);
  const cancelPendingRename = useCallback(() => {
    if (renameTimer.current !== null) {
      window.clearTimeout(renameTimer.current);
      renameTimer.current = null;
    }
  }, []);
  useEffect(() => cancelPendingRename, [cancelPendingRename]);

  const onRowClick = useCallback<ExplorerCtx['onRowClick']>(
    (row, e) => {
      cancelPendingRename();
      setFocusedPath(row.path);
      if (e.metaKey || e.ctrlKey) {
        setSelection((prev) => {
          const next = new Set(prev);
          if (next.has(row.path)) next.delete(row.path);
          else next.add(row.path);
          return next;
        });
        anchorRef.current = row.path;
        return;
      }
      if (e.shiftKey && anchorRef.current) {
        setSelection(new Set(rangeBetween(visibleRows, anchorRef.current, row.path)));
        return;
      }
      const now = Date.now();
      const prev = lastRowClick.current;
      lastRowClick.current = { id: row.path, at: now };
      if (
        row.type !== 'dir' &&
        !readOnly &&
        !editing &&
        selection.size === 1 &&
        selection.has(row.path) &&
        isSecondClick(prev, row.path, now)
      ) {
        renameTimer.current = window.setTimeout(() => {
          renameTimer.current = null;
          setEditing({ mode: 'rename', path: row.path });
        }, 500);
        return;
      }
      setSelection(new Set([row.path]));
      anchorRef.current = row.path;
      // A single click opens a file as an ephemeral preview tab (the default);
      // a directory toggles on EVERY click, so double-clicking a folder opens
      // and closes it again — nothing else competes for a folder's clicks.
      if (row.type === 'dir') toggle(row.path);
      else onOpenFile?.(sid, row.path);
    },
    [visibleRows, toggle, onOpenFile, sid, selection, editing, readOnly, cancelPendingRename],
  );

  // A double click pins a FILE — opening it (or promoting its preview tab) as
  // a permanent tab, matching VSCode — and cancels a click-to-rename the
  // second click just scheduled. A FOLDER has nothing to do here: its two
  // clicks have already toggled it twice, which is the gesture.
  const onRowDoubleClick = useCallback<ExplorerCtx['onRowDoubleClick']>(
    (row) => {
      cancelPendingRename();
      if (row.type !== 'dir') onOpenFile?.(sid, row.path, { preview: false });
    },
    [onOpenFile, sid, cancelPendingRename],
  );

  const selectOnly = useCallback((path: string) => {
    setSelection(new Set([path]));
    setFocusedPath(path);
    anchorRef.current = path;
  }, []);

  // Prune nested paths so a selection of a folder plus its children acts on
  // the folder once (pasting/moving/deleting the parent already covers them).
  const cut = useCallback(
    (paths: string[]) => setExplorerClipboard(pruneNested(paths), 'cut', target),
    [target],
  );
  const copy = useCallback(
    (paths: string[]) => setExplorerClipboard(pruneNested(paths), 'copy', target),
    [target],
  );
  const clipboardFromThisHost = clipboard !== null && sameDaemonHost(clipboard.source, target);
  const clipboardFromThisTree = clipboard !== null && sameFiletree(clipboard.source, target);
  const canPaste =
    !readOnly &&
    ((clipboardFromThisHost && clipboardFromThisTree) ||
      (clipboard !== null &&
        confirmedSameDaemonHost(clipboard.source, target) &&
        crossFiletreeTransferSupported(protocol)));
  const isCut = useCallback(
    (path: string) =>
      clipboard?.mode === 'cut' &&
      sameDaemonHost(clipboard.source, target) &&
      sameFiletree(clipboard.source, target) &&
      clipboard.paths.includes(path),
    [clipboard, target],
  );
  // The mutating entry points all short-circuit under `readOnly`, so a keyboard
  // shortcut or a stale menu can never reach `fs` — the menus merely stop
  // OFFERING them.
  const paste = useCallback(
    (targetDir: string) => {
      if (!clipboard || readOnly) return;
      const sameTree = sameFiletree(clipboard.source, target);
      if (!sameDaemonHost(clipboard.source, target)) {
        toast.error('That filetree clipboard belongs to another daemon host.');
        return;
      }
      if (!sameTree && !confirmedSameDaemonHost(clipboard.source, target)) {
        toast.error('Copy again after daemon host information finishes loading.');
        return;
      }
      if (!sameTree && !crossFiletreeTransferSupported(protocol)) {
        toast.error('Cross-filetree paste requires a daemon with protocol 16.3.');
        return;
      }
      void fs.paste(clipboard, targetDir).then((failedPaths) => {
        if (clipboard.mode === 'cut') finishExplorerCut(clipboard.id, failedPaths);
      });
    },
    [clipboard, fs, protocol, readOnly, target],
  );

  const onClipboardPaste = useCallback<ExplorerCtx['onClipboardPaste']>(
    (items, files) => {
      // A rename/create input owns ordinary text paste while it is mounted.
      if (readOnly || editing) return false;
      const focusedRow = focusedPath
        ? visibleRows.find((row) => row.path === focusedPath)
        : undefined;
      const targetDir = focusedRow
        ? focusedRow.type === 'dir'
          ? focusedRow.path
          : focusedRow.parentDir
        : '';

      // Native clipboard files win over Puddle's persistent tree clipboard.
      // Capture them before returning from this dispatch; Chromium invalidates
      // DataTransferItem access after the paste event has unwound.
      if (hasPastedFiles(items, files)) {
        collectPastedFiles(items, files, foldersSupported)
          .then((collected) => onUpload(targetDir, collected))
          .catch((e: unknown) =>
            toast.error(e instanceof Error ? e.message : "Couldn't read the pasted files"),
          );
        return true;
      }
      if (canPaste) {
        paste(targetDir);
        return true;
      }
      return false;
    },
    [readOnly, editing, focusedPath, visibleRows, foldersSupported, onUpload, canPaste, paste],
  );

  const beginRename = useCallback(
    (path: string) => {
      if (!readOnly) setEditing({ mode: 'rename', path });
    },
    [readOnly],
  );
  const beginCreate = useCallback(
    (parentDir: string, kind: 'file' | 'dir') => {
      if (readOnly) return;
      if (parentDir !== '') expand(parentDir);
      setEditing({ mode: 'create', parentDir, kind });
    },
    [expand, readOnly],
  );
  const cancelEdit = useCallback(() => setEditing(null), []);
  const commitEdit = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      const current = editing;
      setEditing(null);
      if (!current || trimmed === '') return;
      if (current.mode === 'rename') {
        if (trimmed === basename(current.path)) return;
        void fs.rename(current.path, trimmed);
      } else {
        void fs.create(current.parentDir, trimmed, current.kind).then((created) => {
          if (created && current.kind === 'file') onOpenFile?.(sid, created);
        });
      }
    },
    [editing, fs, onOpenFile, sid],
  );

  const requestDelete = useCallback(
    (paths: string[]) => {
      if (readOnly) return;
      const pruned = pruneNested(paths);
      if (pruned.length > 0) setPendingDelete(pruned);
    },
    [readOnly],
  );
  const confirmDelete = useCallback(() => {
    const paths = pendingDelete;
    setPendingDelete(null);
    if (paths) void fs.remove(paths);
  }, [pendingDelete, fs]);
  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  const copyPathToClipboard = useCallback(
    (paths: string[], relative: boolean) => {
      const text = paths.map((p) => copyablePath(rootPath, p, relative)).join('\n');
      void navigator.clipboard.writeText(text);
      const label = relative ? 'Relative path' : 'Path';
      toast.success(
        paths.length > 1 ? `${paths.length} ${label.toLowerCase()}s copied` : `${label} copied`,
      );
    },
    [rootPath],
  );
  const download = useCallback(
    (paths: string[]) => {
      // Sequential, not parallel — several simultaneous programmatic anchor
      // clicks make browsers drop all but the last download.
      void (async () => {
        for (const path of pruneNested(paths)) await downloadPath(sid, path, root);
      })().catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Download failed'));
    },
    [sid, root],
  );
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['wt-tree', sid] });
    // This mounted query is the decoration map the visible tree is actually
    // rendering, including a root-qualified parent-directory browse. Refetch
    // it directly so the Refresh button does not rely on invalidation's
    // active-query scheduling to update Git state.
    void refetchStatus();
  }, [qc, sid, refetchStatus]);

  const onInternalDrop = useCallback(
    (targetDir: string, draggedPaths: string[]) => {
      if (readOnly) return;
      const movable = pruneNested(draggedPaths).filter((p) => canMoveInto(p, targetDir));
      if (movable.length > 0) void fs.move(movable, targetDir);
    },
    [fs, readOnly],
  );

  // Selection to act on for keyboard ops: the multi-selection if it holds the
  // focused row, else just the focused row (so a shortcut always targets what
  // the eye is on).
  const actionTargets = useCallback((): string[] => {
    if (focusedPath && selection.has(focusedPath)) return [...selection];
    if (focusedPath) return [focusedPath];
    return [...selection];
  }, [focusedPath, selection]);

  const typeahead = useRef<{ buffer: string; at: number }>({ buffer: '', at: 0 });

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (editing) return; // the inline input owns the keyboard
      const rows = visibleRows;
      if (rows.length === 0) return;
      const idx = focusedPath ? rows.findIndex((r) => r.path === focusedPath) : -1;
      const focus = (i: number, extend: boolean) => {
        const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
        if (!row) return;
        setFocusedPath(row.path);
        if (extend && anchorRef.current) {
          setSelection(new Set(rangeBetween(rows, anchorRef.current, row.path)));
        } else {
          setSelection(new Set([row.path]));
          anchorRef.current = row.path;
        }
      };
      const cur = idx >= 0 ? rows[idx] : undefined;
      const meta = e.metaKey || e.ctrlKey;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          focus(idx + 1, e.shiftKey);
          return;
        case 'ArrowUp':
          e.preventDefault();
          focus(idx <= 0 ? 0 : idx - 1, e.shiftKey);
          return;
        case 'ArrowRight':
          e.preventDefault();
          if (cur?.type === 'dir' && !expanded.has(cur.path)) expand(cur.path);
          else if (cur?.type === 'dir') focus(idx + 1, false);
          return;
        case 'ArrowLeft':
          e.preventDefault();
          if (cur?.type === 'dir' && expanded.has(cur.path)) toggle(cur.path);
          else if (cur) {
            const parent = rows.findIndex((r) => r.path === cur.parentDir);
            if (parent >= 0) focus(parent, false);
          }
          return;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (!cur) return;
          if (cur.type === 'dir') toggle(cur.path);
          else onOpenFile?.(sid, cur.path);
          return;
        case 'F2':
          e.preventDefault();
          if (cur) beginRename(cur.path);
          return;
        case 'Delete':
          e.preventDefault();
          requestDelete(actionTargets());
          return;
        case 'Backspace':
          if (meta) {
            e.preventDefault();
            requestDelete(actionTargets());
          }
          return;
      }

      if (meta && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        const targets = actionTargets();
        if (e.altKey) copyPathToClipboard(targets, e.shiftKey);
        else copy(targets);
        return;
      }
      if (meta && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault();
        cut(actionTargets());
        return;
      }
      // Type-to-jump: match the next visible row by name prefix.
      if (!meta && !e.altKey && e.key.length === 1 && /\S/.test(e.key)) {
        const now = Date.now();
        const t = typeahead.current;
        t.buffer = now - t.at > 700 ? e.key : t.buffer + e.key;
        t.at = now;
        const needle = t.buffer.toLowerCase();
        const start = idx + 1;
        for (let n = 0; n < rows.length; n++) {
          const row = rows[(start + n) % rows.length]!;
          if (row.name.toLowerCase().startsWith(needle)) {
            focus(
              rows.findIndex((r) => r.path === row.path),
              false,
            );
            break;
          }
        }
      }
    },
    [
      editing,
      visibleRows,
      focusedPath,
      expanded,
      expand,
      toggle,
      onOpenFile,
      sid,
      beginRename,
      requestDelete,
      actionTargets,
      copy,
      cut,
      copyPathToClipboard,
    ],
  );

  const value: ExplorerCtx = {
    sid,
    rootPath,
    root,
    readOnly,
    onOpenFile,
    onOpenTerminal,
    activePath,
    compilableExtensions,
    onOpenCompilationSettings,
    expanded,
    toggle,
    collapseAll,
    statusMap,
    visibleRows,
    selection,
    focusedPath,
    onRowClick,
    onRowDoubleClick,
    selectOnly,
    clipboard,
    canPaste,
    isCut,
    cut,
    copy,
    paste,
    editing,
    beginRename,
    beginCreate,
    cancelEdit,
    commitEdit,
    nameProblem,
    requestDelete,
    copyPathToClipboard,
    download,
    refresh,
    onUpload,
    onDropUpload,
    onClipboardPaste,
    dropTarget,
    setDropTarget,
    onInternalDrop,
    handleKeyDown,
    pendingDelete,
    confirmDelete,
    cancelDelete,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
