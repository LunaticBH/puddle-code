import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FolderTree, List } from 'lucide-react';
import { HoverMarquee } from '../../components/hover-marquee';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { requestReveal } from '../../lib/navigation/reveal-in-tree';
import { useWorktreeDiff } from '../../lib/queries/worktree-queries';
import { cn } from '../../lib/utils';
import { diffStatusStyle, summariseCounts } from '../diff/diff-status';
import { buildFileTree, flatFileList, type TreeNode } from './file-tree';

/** Which hover drives a row's marquee: the row itself (`group`). */
const ROW_MARQUEE = 'group-hover:[transform:translateX(var(--tail))]';

/** A single changed-file row (shared by tree and flat views). */
function FileRow({
  name,
  fullPath,
  status,
  depth,
  active,
  onOpen,
}: {
  name: string;
  fullPath: string;
  status: import('@puddle/shared').DiffStatus;
  depth: number;
  active: boolean;
  onOpen: (path: string, opts?: { preview?: boolean }) => void;
}) {
  const style = diffStatusStyle(status);
  return (
    <button
      type="button"
      title={fullPath}
      // Single click peeks (a preview tab), double click pins — the files
      // tree's semantics, so a result behaves like a file (SPEC §8).
      onClick={() => onOpen(fullPath)}
      onDoubleClick={() => onOpen(fullPath, { preview: false })}
      className={cn(
        'group flex w-full items-center gap-1.5 py-1 pr-3 text-left transition-colors hover:bg-elevated',
        active && 'bg-selection',
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className={cn('w-3 shrink-0 text-center font-mono text-xs', style.colourClass)}>
        {style.letter}
      </span>
      <HoverMarquee text={name} className="text-xs text-fg" hoverClass={ROW_MARQUEE} />
    </button>
  );
}

/** Renders a tree node (directory rows are collapsible; files open a diff tab). */
function TreeRows({
  nodes,
  depth,
  activePath,
  onOpen,
}: {
  nodes: TreeNode[];
  depth: number;
  activePath: string | null;
  onOpen: (path: string, opts?: { preview?: boolean }) => void;
}) {
  // Directories default to expanded — a diff is usually small and worth seeing.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  return (
    <>
      {nodes.map((node) => {
        if (node.type === 'file') {
          return (
            <FileRow
              key={node.path}
              name={node.name}
              fullPath={node.path}
              status={node.entry.status}
              depth={depth}
              active={activePath === node.path}
              onOpen={onOpen}
            />
          );
        }
        const isCollapsed = collapsed.has(node.path);
        return (
          <div key={node.path}>
            <button
              type="button"
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                })
              }
              className="group flex w-full items-center gap-1 py-1 pr-3 text-left transition-colors hover:bg-elevated"
              style={{ paddingLeft: 8 + depth * 12 }}
              title={node.path}
            >
              {isCollapsed ? (
                <ChevronRight className="size-3.5 shrink-0 text-fg-gold" />
              ) : (
                <ChevronDown className="size-3.5 shrink-0 text-fg-gold" />
              )}
              {/* A compacted directory row carries the whole `a/b/c` run, so it
                  is the row most likely to be clipped — it eases leftwards on
                  hover. Its click stays the collapse toggle: a folder's clicks
                  belong to expanding it (as in the files tree). */}
              <HoverMarquee
                text={node.name}
                className="text-xs text-fg-secondary"
                hoverClass={ROW_MARQUEE}
              />
            </button>
            {!isCollapsed && (
              <TreeRows
                nodes={node.children}
                depth={depth + 1}
                activePath={activePath}
                onOpen={onOpen}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * The Changes navigator's top panel (SPEC §8): the worktree's uncommitted
 * changes (staged + unstaged, plus untracked), as a compacted tree or a flat
 * list. Polls via `useWorktreeDiff(session, { against: 'head' })`; clicking a
 * file opens its diff as a centre-editor tab. The active diff tab's file is
 * highlighted.
 */
export function UncommittedPanel({
  session,
  root,
  activePath,
  onOpen,
}: {
  session: string;
  /** `?root=` for a directory target (protocol 12.4); undefined for a worktree. */
  root?: string;
  activePath: string | null;
  onOpen: (path: string, opts?: { preview?: boolean }) => void;
}) {
  const [flat, setFlat] = useState(false);
  const diff = useWorktreeDiff(session, { against: 'head', root });
  const entries = diff.data?.entries ?? [];
  // Opening a change also LOCATES the file in the Files tree (SPEC §8) — the
  // diff answers "what changed", the tree answers "where does this live", and a
  // changed path should not make you go and find it by hand. Latched, so the
  // sidebar stays on the changes you are reading (`lib/reveal-in-tree`).
  const openFile = (path: string, opts?: { preview?: boolean }) => {
    onOpen(path, opts);
    requestReveal({ path, root });
  };
  const tree = useMemo(() => (flat ? null : buildFileTree(entries)), [flat, entries]);
  const flatList = useMemo(() => (flat ? flatFileList(entries) : null), [flat, entries]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 px-3">
        <span className="text-2xs font-medium uppercase tracking-wide text-fg-gold">
          Uncommitted
        </span>
        {entries.length > 0 && (
          <span className="truncate text-2xs text-fg-muted">{summariseCounts(entries)}</span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-pressed={!flat}
              onClick={() => setFlat((f) => !f)}
              className="ml-auto rounded-sm p-1 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
            >
              {flat ? <List className="size-3.5" /> : <FolderTree className="size-3.5" />}
              <span className="sr-only">{flat ? 'Show as tree' : 'Show as flat list'}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{flat ? 'Show as tree' : 'Show as flat list'}</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {diff.isPending ? (
          <div className="px-3 py-1.5 text-xs text-fg-muted">Loading changes…</div>
        ) : diff.error ? (
          <div className="px-3 py-1.5 text-xs text-fg-muted">
            {diff.error instanceof Error ? diff.error.message : 'Failed to load changes'}
          </div>
        ) : entries.length === 0 ? (
          <div className="px-3 py-1.5 text-xs text-fg-muted">No uncommitted changes.</div>
        ) : flat ? (
          flatList!.map((node) => (
            <FileRow
              key={node.path}
              name={node.path}
              fullPath={node.path}
              status={node.entry.status}
              depth={0}
              active={activePath === node.path}
              onOpen={openFile}
            />
          ))
        ) : (
          <TreeRows nodes={tree!} depth={0} activePath={activePath} onOpen={openFile} />
        )}
      </div>
    </div>
  );
}
