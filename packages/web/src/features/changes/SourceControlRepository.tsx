import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { GitArea, GitChangeEntry, GitRepository } from '@puddle/shared';
import {
  ChevronDown,
  ChevronRight,
  Download,
  FolderTree,
  List,
  Minus,
  Plus,
  Send,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { HoverMarquee } from '../../components/hover-marquee';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { useGitMutation } from '../../lib/queries/worktree-queries';
import { cn } from '../../lib/utils';
import { gitDecoration } from '../explorer/git-decoration';
import { buildFileTree, treeEntries, type TreeNode } from './file-tree';
import { gitEntryPaths } from './source-control-paths';

/** Which hover drives the branch/status marquee: its own action row. */
const STATUS_MARQUEE = 'group-hover:[transform:translateX(var(--tail))]';
/** The mixed-style repository heading follows its own heading row. */
const HEADING_MARQUEE = 'group-hover/repository:[transform:translateX(var(--tail))]';
/** Changed-file and directory labels follow their own row. */
const CHANGE_MARQUEE = 'group-hover:[transform:translateX(var(--tail))]';

export interface SourceControlOpenOptions {
  preview?: boolean;
  root?: string;
  gitArea?: GitArea;
}

function IconAction({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
          className={cn(
            'rounded-sm p-1 text-fg-muted transition-colors hover:bg-elevated hover:text-fg disabled:cursor-not-allowed disabled:opacity-40',
            className,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ChangeGroup({
  title,
  entries,
  area,
  activePath,
  action,
  busy,
  flat,
  onAction,
  onOpen,
}: {
  title: string;
  entries: GitChangeEntry[];
  area: GitArea;
  activePath: string | null;
  action: 'stage' | 'unstage';
  busy: boolean;
  flat: boolean;
  onAction(paths: string[]): void;
  onOpen(path: string, opts?: SourceControlOpenOptions): void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const tree = useMemo(() => (flat ? null : buildFileTree(entries)), [entries, flat]);
  if (entries.length === 0) return null;
  const stage = action === 'stage';
  return (
    <div>
      <div className="group flex h-7 items-center gap-1 px-3">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-2xs font-medium uppercase tracking-wide text-fg-gold transition-colors hover:text-fg"
        >
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          <span className="truncate">{title}</span>
          <span className="ml-1 text-fg-muted">{entries.length}</span>
        </button>
        <IconAction
          label={`${stage ? 'Stage' : 'Unstage'} all ${title.toLowerCase()}`}
          disabled={busy}
          onClick={() => onAction(gitEntryPaths(entries))}
        >
          {stage ? <Plus className="size-3.5" /> : <Minus className="size-3.5" />}
        </IconAction>
      </div>
      {!collapsed &&
        (flat ? (
          entries.map((entry) => (
            <ChangeFileRow
              key={`${entry.path}:${entry.old_path ?? ''}`}
              entry={entry}
              name={entry.path}
              depth={0}
              area={area}
              active={activePath === entry.path}
              action={action}
              busy={busy}
              onAction={onAction}
              onOpen={onOpen}
            />
          ))
        ) : (
          <ChangeTreeRows
            nodes={tree!}
            depth={0}
            area={area}
            activePath={activePath}
            action={action}
            busy={busy}
            onAction={onAction}
            onOpen={onOpen}
          />
        ))}
    </div>
  );
}

function ChangeFileRow({
  entry,
  name,
  depth,
  area,
  active,
  action,
  busy,
  onAction,
  onOpen,
}: {
  entry: GitChangeEntry;
  name: string;
  depth: number;
  area: GitArea;
  active: boolean;
  action: 'stage' | 'unstage';
  busy: boolean;
  onAction(paths: string[]): void;
  onOpen(path: string, opts?: SourceControlOpenOptions): void;
}) {
  const decoration = gitDecoration(entry.status);
  const stage = action === 'stage';
  return (
    <div
      className={cn(
        'group flex items-center gap-1 pr-3 transition-colors hover:bg-elevated',
        active && 'bg-selection',
      )}
      style={{ paddingLeft: 12 + depth * 12 }}
    >
      <button
        type="button"
        title={entry.path}
        onClick={() => onOpen(entry.path, { root: undefined, gitArea: area })}
        onDoubleClick={() => onOpen(entry.path, { preview: false, root: undefined, gitArea: area })}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
      >
        <span className={cn('w-3 shrink-0 text-center font-mono text-xs', decoration.colourClass)}>
          {decoration.letter}
        </span>
        <HoverMarquee text={name} className="text-xs text-fg" hoverClass={CHANGE_MARQUEE} />
      </button>
      <IconAction
        label={`${stage ? 'Stage' : 'Unstage'} ${entry.path}`}
        disabled={busy}
        onClick={() => onAction(gitEntryPaths([entry]))}
      >
        {stage ? <Plus className="size-3.5" /> : <Minus className="size-3.5" />}
      </IconAction>
    </div>
  );
}

function ChangeTreeRows({
  nodes,
  depth,
  area,
  activePath,
  action,
  busy,
  onAction,
  onOpen,
}: {
  nodes: TreeNode<GitChangeEntry>[];
  depth: number;
  area: GitArea;
  activePath: string | null;
  action: 'stage' | 'unstage';
  busy: boolean;
  onAction(paths: string[]): void;
  onOpen(path: string, opts?: SourceControlOpenOptions): void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const stage = action === 'stage';
  return (
    <>
      {nodes.map((node) => {
        if (node.type === 'file') {
          return (
            <ChangeFileRow
              key={`${node.entry.path}:${node.entry.old_path ?? ''}`}
              entry={node.entry}
              name={node.name}
              depth={depth}
              area={area}
              active={activePath === node.path}
              action={action}
              busy={busy}
              onAction={onAction}
              onOpen={onOpen}
            />
          );
        }
        const isCollapsed = collapsed.has(node.path);
        return (
          <div key={node.path}>
            <div
              className="group flex items-center gap-1 pr-3 transition-colors hover:bg-elevated"
              style={{ paddingLeft: 12 + depth * 12 }}
            >
              <button
                type="button"
                title={node.path}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(node.path)) next.delete(node.path);
                    else next.add(node.path);
                    return next;
                  })
                }
                className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left"
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3.5 shrink-0 text-fg-gold" />
                ) : (
                  <ChevronDown className="size-3.5 shrink-0 text-fg-gold" />
                )}
                <HoverMarquee
                  text={node.name}
                  className="text-xs text-fg-secondary"
                  hoverClass={CHANGE_MARQUEE}
                />
              </button>
              <IconAction
                label={`${stage ? 'Stage' : 'Unstage'} ${node.path}`}
                disabled={busy}
                onClick={() => onAction(gitEntryPaths(treeEntries(node)))}
              >
                {stage ? <Plus className="size-3.5" /> : <Minus className="size-3.5" />}
              </IconAction>
            </div>
            {!isCollapsed && (
              <ChangeTreeRows
                nodes={node.children}
                depth={depth + 1}
                area={area}
                activePath={activePath}
                action={action}
                busy={busy}
                onAction={onAction}
                onOpen={onOpen}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function branchLabel(repository: GitRepository): string {
  if (repository.detached) return `Detached at ${repository.head?.slice(0, 8) ?? 'HEAD'}`;
  return repository.branch ?? 'Unborn branch';
}

function statusLabel(repository: GitRepository): string {
  return [
    branchLabel(repository),
    repository.upstream,
    repository.ahead > 0 ? `${repository.ahead} ahead` : null,
    repository.behind > 0 ? `${repository.behind} behind` : null,
  ]
    .filter((part): part is string => part !== null && part !== undefined)
    .join(' · ');
}

/** One collapsible VS Code-style source-control repository group. */
export function SourceControlRepository({
  session,
  targetRoot,
  repository,
  selected,
  activePath,
  onSelect,
  onOpen,
}: {
  session: string;
  targetRoot?: string;
  repository: GitRepository;
  selected: boolean;
  activePath: string | null;
  onSelect(): void;
  onOpen(path: string, opts?: SourceControlOpenOptions): void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [flat, setFlat] = useState(false);
  const [message, setMessage] = useState('');
  const mutation = useGitMutation(session, targetRoot);
  const changes = [...repository.conflicts, ...repository.staged, ...repository.unstaged];
  const busy = mutation.isPending;

  const run = async (variables: Parameters<typeof mutation.mutateAsync>[0], success: string) => {
    try {
      await mutation.mutateAsync(variables);
      toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Git operation failed');
    }
  };
  const changePaths = (action: 'stage' | 'unstage', paths: string[]) => {
    void run(
      { action, repository: repository.root, paths },
      action === 'stage' ? 'Staged' : 'Unstaged',
    );
  };
  const commit = async () => {
    const trimmed = message.trim();
    if (!trimmed || busy) return;
    let stageAll = false;
    if (repository.staged.length === 0) {
      if (repository.conflicts.length > 0) {
        toast.error('Resolve and stage merge changes before committing');
        return;
      }
      if (repository.unstaged.length === 0) {
        toast.error('There are no changes to commit');
        return;
      }
      stageAll = window.confirm('Nothing is staged. Stage every change and commit it?');
      if (!stageAll) return;
    }
    try {
      await mutation.mutateAsync({
        action: 'commit',
        repository: repository.root,
        message: trimmed,
        stage_all: stageAll,
      });
      setMessage('');
      toast.success('Committed');
    } catch (error) {
      // Keep the message: a failed commit should be immediately retryable.
      toast.error(error instanceof Error ? error.message : 'Commit failed');
    }
  };
  const onMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void commit();
    }
  };
  const openInRepository = (path: string, opts?: SourceControlOpenOptions) =>
    onOpen(path, { ...opts, root: repository.root });

  return (
    <section className={cn('py-0.5', selected && 'bg-surface/40')} onFocus={onSelect}>
      <div className="flex h-8 items-center gap-1 pl-2 pr-2">
        <button
          type="button"
          onClick={() => {
            onSelect();
            setCollapsed((value) => !value);
          }}
          className="group/repository flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors hover:text-fg"
        >
          {collapsed ? (
            <ChevronRight className="size-3 shrink-0" />
          ) : (
            <ChevronDown className="size-3 shrink-0" />
          )}
          <HoverMarquee
            text={`${repository.name} ${repository.relative_path}`}
            title={`${repository.name} ${repository.relative_path}`}
            className="text-xs"
            hoverClass={HEADING_MARQUEE}
          >
            <span className="font-medium text-fg">{repository.name}</span>{' '}
            <span className="text-2xs text-fg-muted">{repository.relative_path}</span>
          </HoverMarquee>
          {changes.length > 0 && (
            <span className="ml-auto text-2xs text-fg-muted">{changes.length}</span>
          )}
        </button>
        {!collapsed && repository.initialised && changes.length > 0 && (
          <IconAction
            label={flat ? 'Show changes as tree' : 'Show changes as flat list'}
            onClick={() => setFlat((value) => !value)}
          >
            {flat ? <List className="size-3.5" /> : <FolderTree className="size-3.5" />}
          </IconAction>
        )}
      </div>
      {!collapsed && (
        <div>
          <div className="group flex min-h-7 items-center px-3 text-2xs text-fg-muted">
            <HoverMarquee
              text={statusLabel(repository)}
              title={statusLabel(repository)}
              hoverClass={STATUS_MARQUEE}
            />
          </div>

          {!repository.initialised ? (
            <div className="px-3 py-2 text-xs text-fg-muted">Submodule not initialised.</div>
          ) : (
            <>
              <div className="px-3 pb-1.5 pt-1">
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={onMessageKeyDown}
                  rows={2}
                  placeholder="Commit message"
                  aria-label={`Commit message for ${repository.name}`}
                  className="w-full resize-none rounded-sm bg-elevated px-2 py-1.5 text-xs text-fg outline-none placeholder:text-fg-muted focus:ring-1 focus:ring-focus"
                />
                <div className="mt-1 flex items-center gap-0.5">
                  {repository.has_remote && (
                    <>
                      <IconAction
                        label="Fetch"
                        disabled={busy}
                        className="flex size-7 shrink-0 items-center justify-center p-0"
                        onClick={() =>
                          void run({ action: 'fetch', repository: repository.root }, 'Fetched')
                        }
                      >
                        <Download className="size-3.5" />
                      </IconAction>
                      {repository.upstream && (
                        <IconAction
                          label="Pull"
                          disabled={busy}
                          className="flex size-7 shrink-0 items-center justify-center p-0"
                          onClick={() =>
                            void run({ action: 'pull', repository: repository.root }, 'Pulled')
                          }
                        >
                          <Upload className="size-3.5 rotate-180" />
                        </IconAction>
                      )}
                      {repository.branch && (
                        <IconAction
                          label={repository.upstream ? 'Push' : 'Publish branch'}
                          disabled={busy}
                          className="flex size-7 shrink-0 items-center justify-center p-0"
                          onClick={() =>
                            void run(
                              {
                                action: 'push',
                                repository: repository.root,
                                set_upstream: !repository.upstream,
                              },
                              repository.upstream ? 'Pushed' : 'Branch published',
                            )
                          }
                        >
                          {repository.upstream ? (
                            <Send className="size-3.5" />
                          ) : (
                            <Upload className="size-3.5" />
                          )}
                        </IconAction>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    disabled={busy || message.trim().length === 0}
                    onClick={() => void commit()}
                    className="flex h-7 min-w-0 flex-1 items-center justify-center rounded-sm bg-action px-2 text-xs text-action-ink transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Commit
                  </button>
                </div>
              </div>
              <ChangeGroup
                title="Merge Changes"
                entries={repository.conflicts}
                area="unstaged"
                activePath={activePath}
                action="stage"
                busy={busy}
                flat={flat}
                onAction={(paths) => changePaths('stage', paths)}
                onOpen={openInRepository}
              />
              <ChangeGroup
                title="Staged Changes"
                entries={repository.staged}
                area="staged"
                activePath={activePath}
                action="unstage"
                busy={busy}
                flat={flat}
                onAction={(paths) => changePaths('unstage', paths)}
                onOpen={openInRepository}
              />
              <ChangeGroup
                title="Changes"
                entries={repository.unstaged}
                area="unstaged"
                activePath={activePath}
                action="stage"
                busy={busy}
                flat={flat}
                onAction={(paths) => changePaths('stage', paths)}
                onOpen={openInRepository}
              />
              {changes.length === 0 && (
                <div className="px-3 py-2 text-xs text-fg-muted">No changes.</div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
