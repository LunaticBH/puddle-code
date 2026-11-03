import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  Bot,
  Eraser,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Play,
  Square,
  SquareTerminal,
  UserRoundCog,
} from 'lucide-react';
import { toast } from 'sonner';
import { liveConversationTarget, toastError } from '../../../lib/transport/errors';
import type { Account, Session } from '@puddle/shared';
import { AgentIcon } from '../../../components/agent-icon';
import { Button } from '../../../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../../../components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';
import { Input } from '../../../components/ui/input';
import { editorDeepLink, editorLinkHost } from '../../../lib/navigation/editor-links';
import {
  useAccounts,
  useArchiveSession,
  useClearSessionEnv,
  useCreateSession,
  useHandoffSession,
  useMigrateSession,
  useProfileSettings,
  useRenameSession,
  useSessionAction,
  useUnarchiveSession,
} from '../../../lib/queries/queries';
import { useCurrentProfileId } from '../../profile/profile-store';

const LIVE: Session['status'][] = ['starting', 'running', 'waiting_input'];
const RESUMABLE: Session['status'][] = ['exited', 'interrupted'];

/**
 * The shared lifecycle-menu model for one session: which actions apply, the
 * handlers behind them, and the confirmation dialogs. Rendered by both the
 * hover ellipsis (`SessionActionsEllipsis`) and the right-click menu
 * (`SessionContextMenu`) so every surface offers the same actions.
 */
export interface SessionMenu {
  session: Session;
  resumable: boolean;
  live: boolean;
  archived: boolean;
  canMigrate: boolean;
  sameAgent: Account[];
  /** Logged-in accounts running a DIFFERENT agent — tier-2 hand-off targets. */
  handoffTargets: Account[];
  setHandoffTo: (account: Account) => void;
  resume: () => void;
  /** Kill straight away — no confirmation (the conversation stays resumable). */
  kill: () => void;
  openRename: () => void;
  /** Confirm-then-clear the session's captured env (SPEC §4). */
  openClearEnv: () => void;
  /** Spawn a terminal session sharing this session's worktree directory. */
  openTerminal: () => void;
  /** Logged-in accounts an agent can spawn on, the default account first. */
  spawnAccounts: Account[];
  /** The profile's default account id (for the "default" marker), or null. */
  defaultAccountId: number | null;
  /** Spawn an agent sharing this session's worktree, on the given account. */
  spawnAgent: (accountId: number) => void;
  /** Archive straight away — no confirmation (SPEC §4: nothing is destroyed). */
  archive: () => void;
  unarchive: () => void;
  setMigrateTo: (a: Account) => void;
}

/** The deliberately small action surface shared by a multi-session selection. */
export interface SessionBatchMenu {
  sessionIds: readonly string[];
  archiveAll: (ids: readonly string[]) => void;
}

/** Menu primitives shared by the dropdown and context-menu renderers. */
interface MenuKit {
  Item: React.ElementType;
  Separator: React.ElementType;
  Sub: React.ElementType;
  SubTrigger: React.ElementType;
  SubContent: React.ElementType;
}

const dropdownKit: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

const contextKit: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

/** Owns the mutations, dialog state, and confirmation dialogs for a session. */
export function useSessionMenu(
  session: Session,
  onArchived?: (id: string) => void,
): { menu: SessionMenu; dialogs: ReactNode } {
  const resume = useSessionAction('resume');
  const kill = useSessionAction('kill');
  const archive = useArchiveSession();
  const unarchive = useUnarchiveSession();
  const rename = useRenameSession();
  const migrate = useMigrateSession();
  const handoff = useHandoffSession();
  const clearEnv = useClearSessionEnv();
  const createSession = useCreateSession();
  const navigate = useNavigate();
  const profileId = useCurrentProfileId();
  const accounts = useAccounts(profileId ?? undefined);
  const settings = useProfileSettings(profileId ?? undefined);
  const [confirm, setConfirm] = useState<'clear-env' | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newTitle, setNewTitle] = useState(session.title ?? '');
  const [migrateTo, setMigrateTo] = useState<Account | null>(null);
  const [handoffTo, setHandoffTo] = useState<Account | null>(null);

  // Migration targets: accounts of the same agent on this profile (SPEC §5).
  // The current account is shown but disabled; a session with no other same-
  // agent account has no target, so the whole submenu is hidden.
  const sameAgent = (accounts.data ?? []).filter((a) => a.agent_type === session.agent_type);
  const canMigrate =
    !session.worktree_missing &&
    session.status !== 'archived' &&
    sameAgent.some((a) => a.id !== session.account_id);

  // Hand-off targets: a DIFFERENT agent, logged in (SPEC §5 tier 2). Same-agent
  // accounts belong on migrate, which keeps the conversation rather than
  // summarising it, so the two never overlap.
  const handoffTargets = (accounts.data ?? []).filter(
    (a) => a.agent_type !== session.agent_type && a.logged_in,
  );

  // Accounts an agent can actually spawn on must be logged in; the profile's
  // default account leads the list so opening the submenu and pressing Enter
  // spawns the default (Radix focuses the first item on keyboard-open).
  const rawDefault = settings.data?.['default_account_id'];
  const defaultAccountId = typeof rawDefault === 'number' ? rawDefault : null;
  const loggedIn = (accounts.data ?? []).filter((a) => a.logged_in);
  const spawnAccounts =
    defaultAccountId !== null
      ? [
          ...loggedIn.filter((a) => a.id === defaultAccountId),
          ...loggedIn.filter((a) => a.id !== defaultAccountId),
        ]
      : loggedIn;

  const menu: SessionMenu = {
    session,
    resumable: RESUMABLE.includes(session.status) && !session.conversation_missing,
    live: LIVE.includes(session.status),
    archived: session.status === 'archived',
    canMigrate,
    sameAgent,
    handoffTargets:
      !session.worktree_missing && session.status !== 'archived' ? handoffTargets : [],
    setHandoffTo,
    resume: () =>
      resume.mutate(session.id, {
        onError: (error) => {
          const target = liveConversationTarget(error);
          if (target) {
            void navigate(`/project/${target.projectId}/session/${target.sessionId}`);
          } else {
            toastError(error);
          }
        },
      }),
    // Killing only stops the process — the conversation stays resumable — so
    // it fires straight away, like archive.
    kill: () => kill.mutate(session.id, { onError: (e) => toastError(e) }),
    openClearEnv: () => setConfirm('clear-env'),
    // A plain shell in THIS session's working directory (SPEC §4: a terminal
    // session joining an existing worktree) — for git surgery, running tests,
    // or poking at files beside the agent. Lands in the new terminal.
    openTerminal: () =>
      createSession.mutate(
        {
          project_id: session.project_id,
          kind: 'terminal',
          separate_branch: false,
          separate_worktree: false,
          join_worktree: session.worktree_path,
        },
        {
          onSuccess: (t) => void navigate(`/project/${t.project_id}/session/${t.id}`),
          onError: (e) => toastError(e),
        },
      ),
    spawnAccounts,
    defaultAccountId,
    // An agent joining THIS session's worktree (shared directory, no new
    // branch) on the chosen account — a second agent beside the first, or a
    // fresh agent on a worktree whose original session has exited.
    spawnAgent: (accountId: number) =>
      createSession.mutate(
        {
          project_id: session.project_id,
          account_id: accountId,
          separate_branch: false,
          separate_worktree: false,
          join_worktree: session.worktree_path,
        },
        {
          onSuccess: (s) => void navigate(`/project/${s.project_id}/session/${s.id}`),
          onError: (e) => toastError(e),
        },
      ),
    openRename: () => {
      setNewTitle(session.title ?? ''); // seed from the current override, not the default
      setRenaming(true);
    },
    // Archiving keeps everything (worktree, branch, conversation), so it needs no
    // confirmation — one click hides it, and the daemon kills a live session as
    // part of it (SPEC §4). onArchived lets the caller drop the now-archived tab
    // from the open panes.
    archive: () =>
      archive.mutate(session.id, {
        onSuccess: () => onArchived?.(session.id),
        onError: (e) => toastError(e),
      }),
    unarchive: () => unarchive.mutate(session.id, { onError: (e) => toastError(e) }),
    setMigrateTo,
  };

  const dialogs = (
    <>
      <Dialog
        open={confirm === 'clear-env'}
        onOpenChange={(open) => {
          if (open) return;
          setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear captured environment?</DialogTitle>
            <DialogDescription>
              Variables exported in this session&rsquo;s terminals will no longer be injected into
              new shells or agent restarts.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={clearEnv.isPending}
              onClick={() =>
                clearEnv.mutate(session.id, {
                  onSuccess: (res) => {
                    setConfirm(null);
                    toast.success(
                      res.cleared === 0
                        ? 'Nothing was captured'
                        : `Cleared ${res.cleared} captured var${res.cleared === 1 ? '' : 's'}`,
                    );
                  },
                  onError: (e) => {
                    setConfirm(null);
                    toastError(e);
                  },
                })
              }
            >
              Clear captured env
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
            <DialogDescription>
              Leave it empty to use the agent&rsquo;s own session name.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              // An empty title clears the override; the daemon reverts the name
              // to the agent's own name (then the id prefix).
              rename.mutate(
                { sessionId: session.id, title: newTitle.trim() },
                {
                  onSuccess: () => setRenaming(false),
                  onError: (err) => toastError(err),
                },
              );
            }}
          >
            <Input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder={session.agent_title ?? session.osc_title ?? session.id.slice(0, 8)}
              autoFocus
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={rename.isPending}>
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={migrateTo !== null} onOpenChange={(open) => !open && setMigrateTo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move this session to {migrateTo?.label}?</DialogTitle>
            <DialogDescription>
              The conversation continues under that account&rsquo;s credentials. If the session is
              running it is stopped first, then resumed on the new account.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMigrateTo(null)}>
              Cancel
            </Button>
            <Button
              disabled={migrate.isPending}
              onClick={() => {
                if (!migrateTo) return;
                migrate.mutate(
                  { sessionId: session.id, accountId: migrateTo.id },
                  {
                    onSuccess: () => {
                      setMigrateTo(null);
                      toast.success(`Moved to ${migrateTo.label}`);
                    },
                    onError: (e) => {
                      setMigrateTo(null);
                      toastError(e);
                    },
                  },
                );
              }}
            >
              Move session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={handoffTo !== null} onOpenChange={(open) => !open && setHandoffTo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hand off to {handoffTo?.agent_type}?</DialogTitle>
            <DialogDescription>
              A new session starts in this worktree and branch on{' '}
              <span className="text-fg">{handoffTo?.label}</span>, opening with a summary of the
              conversation so far plus the branch&rsquo;s commits and status. The conversation
              itself is summarised, not moved — the new agent will not have the old one&rsquo;s
              reasoning. This session is left as it is.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setHandoffTo(null)}>
              Cancel
            </Button>
            <Button
              disabled={handoff.isPending}
              onClick={() => {
                if (!handoffTo) return;
                handoff.mutate(
                  { sessionId: session.id, accountId: handoffTo.id },
                  {
                    onSuccess: (created) => {
                      setHandoffTo(null);
                      toast.success(`Handed off to ${handoffTo.agent_type}`);
                      navigate(`/session/${created.id}`);
                    },
                    onError: (e) => {
                      setHandoffTo(null);
                      toastError(e);
                    },
                  },
                );
              }}
            >
              Hand off
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  return { menu, dialogs };
}

/** The action items, rendered with either the dropdown or context-menu kit. */
function SessionMenuItems({ kit, menu }: { kit: MenuKit; menu: SessionMenu }) {
  const { Item, Separator, Sub, SubTrigger, SubContent } = kit;
  const { session } = menu;
  return (
    <>
      {menu.resumable && !session.worktree_missing && (
        <Item onSelect={menu.resume}>
          <Play /> Resume
        </Item>
      )}
      {menu.live && (
        <Item onSelect={menu.kill}>
          <Square /> Kill
        </Item>
      )}
      <Item onSelect={menu.openRename}>
        <Pencil /> Rename
      </Item>
      {!menu.archived && (
        <Item onSelect={menu.openClearEnv}>
          <Eraser /> Clear captured env
        </Item>
      )}
      {menu.canMigrate && (
        <Sub>
          <SubTrigger>
            <UserRoundCog /> Move to account…
          </SubTrigger>
          <SubContent>
            {menu.sameAgent.map((a) => {
              const current = a.id === session.account_id;
              return (
                <Item key={a.id} disabled={current} onSelect={() => menu.setMigrateTo(a)}>
                  {a.label}
                  {current && <span className="ml-auto text-fg-muted">current</span>}
                </Item>
              );
            })}
          </SubContent>
        </Sub>
      )}
      {menu.handoffTargets.length > 0 && (
        <Sub>
          <SubTrigger>
            <ArrowRightLeft /> Hand off to agent…
          </SubTrigger>
          <SubContent>
            {menu.handoffTargets.map((a) => (
              <Item key={a.id} onSelect={() => menu.setHandoffTo(a)}>
                <AgentIcon type={a.agent_type} className="size-4" />
                {a.agent_type}
                <span className="ml-auto text-fg-muted">{a.label}</span>
              </Item>
            ))}
          </SubContent>
        </Sub>
      )}
      {!session.worktree_missing && (
        <>
          <Separator />
          <Item onSelect={menu.openTerminal}>
            <SquareTerminal /> Open terminal in worktree
          </Item>
          {menu.spawnAccounts.length > 0 && (
            <Sub>
              <SubTrigger>
                <Bot /> Spawn agent in worktree
              </SubTrigger>
              <SubContent>
                {menu.spawnAccounts.map((a) => (
                  <Item key={a.id} onSelect={() => menu.spawnAgent(a.id)}>
                    <AgentIcon type={a.agent_type} className="size-4 shrink-0" />
                    {a.agent_type}/{a.label}
                    {a.id === menu.defaultAccountId && (
                      <span className="ml-auto pl-3 text-fg-muted">default</span>
                    )}
                  </Item>
                ))}
              </SubContent>
            </Sub>
          )}
          {/* Deep links, not regular navigation — window.location.href hands the
              URL to the OS/editor and leaves the tab in place. */}
          <Item
            onSelect={() => {
              window.location.href = editorDeepLink(
                'vscode',
                session.worktree_path,
                editorLinkHost(),
              );
            }}
          >
            <ExternalLink /> Open in VS Code
          </Item>
          <Item
            onSelect={() => {
              window.location.href = editorDeepLink(
                'cursor',
                session.worktree_path,
                editorLinkHost(),
              );
            }}
          >
            <ExternalLink /> Open in Cursor
          </Item>
        </>
      )}
      {/* Archive is always one click away, live or not — the daemon kills a
          live session as part of archiving, and nothing is destroyed either
          way (SPEC §4), so there is no confirmation. */}
      {!menu.archived && (
        <>
          <Separator />
          <Item onSelect={menu.archive}>
            <Archive /> Archive
          </Item>
        </>
      )}
      {menu.archived && (
        <>
          <Separator />
          <Item onSelect={menu.unarchive}>
            <ArchiveRestore /> Unarchive
          </Item>
        </>
      )}
    </>
  );
}

/** Batch actions replace the single-session menu when its trigger is selected. */
function SessionBatchMenuItems({ batch }: { batch: SessionBatchMenu }) {
  return (
    <ContextMenuItem onSelect={() => batch.archiveAll(batch.sessionIds)}>
      <Archive /> Archive all
      <span className="ml-auto pl-3 tabular-nums text-fg-muted">{batch.sessionIds.length}</span>
    </ContextMenuItem>
  );
}

/** The hover ellipsis trigger — shares `menu` with the row's context menu. */
export function SessionActionsEllipsis({ menu }: { menu: SessionMenu }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-6" onClick={(e) => e.preventDefault()}>
          <MoreHorizontal />
          <span className="sr-only">Session actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <SessionMenuItems kit={dropdownKit} menu={menu} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Wraps a session surface (sidebar row, top tab) so right-clicking it opens the
 * same lifecycle menu as the ellipsis. `children` may be a render function that
 * receives the shared `menu` (so a row can also mount `SessionActionsEllipsis`
 * over the same model); the confirmation dialogs are rendered once here.
 */
export function SessionContextMenu({
  session,
  onArchived,
  batch,
  children,
}: {
  session: Session;
  onArchived?: (id: string) => void;
  /** Present only when this trigger belongs to a multi-session selection. */
  batch?: SessionBatchMenu;
  children: React.ReactElement | ((menu: SessionMenu) => React.ReactElement);
}) {
  const { menu, dialogs } = useSessionMenu(session, onArchived);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {typeof children === 'function' ? children(menu) : children}
        </ContextMenuTrigger>
        <ContextMenuContent>
          {batch ? (
            <SessionBatchMenuItems batch={batch} />
          ) : (
            <SessionMenuItems kit={contextKit} menu={menu} />
          )}
        </ContextMenuContent>
      </ContextMenu>
      {dialogs}
    </>
  );
}

/** For surfaces that need the menu but compose their own trigger (e.g. the
 *  tooltip-wrapped collapsed dot): renders the context-menu content + dialogs. */
export function SessionContextMenuBody({
  menu,
  batch,
}: {
  menu: SessionMenu;
  batch?: SessionBatchMenu;
}) {
  return (
    <ContextMenuContent>
      {batch ? (
        <SessionBatchMenuItems batch={batch} />
      ) : (
        <SessionMenuItems kit={contextKit} menu={menu} />
      )}
    </ContextMenuContent>
  );
}
