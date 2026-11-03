import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  hostBasename,
  hostPathStyle,
  type Project,
  type Session,
  type SessionKind,
} from '@puddle/shared';
import { Button } from '../../../components/ui/button';
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
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';
import { HintInput } from '../../../components/ui/hint-input';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import { Switch } from '../../../components/ui/switch';
import { cn } from '../../../lib/utils';
import { openSettings } from '../../../lib/navigation/hash-route';
import {
  useAccounts,
  useCreateSession,
  useHostInfo,
  useProfileSettings,
  useProjects,
  useRepoBranches,
  useRepoWorktrees,
  useRepos,
} from '../../../lib/queries/queries';
import { tildify } from '../../../lib/tildify';
import { useCurrentProfileId } from '../../profile/profile-store';
import { orderAccountPickerItems } from './account-picker-order';
import { resolveSessionSeed } from './session-seed';

/** A worktree directory's own name, for the join picker; a Windows host's splits on `\`. */
function worktreeName(path: string): string {
  if (hostPathStyle(path) === 'win32') return hostBasename(path) || path;
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * Project → account → branch → directory (SPEC §4/§11). Two independent axes
 * decide where the session lands: **separate branch** (a fresh branch in its own
 * worktree) and, when that is off, **separate directory** (its own working copy
 * of the base branch; turn it off to share a directory — picking an existing one
 * to drop into). Both axes and the base branch open on the profile's per-kind
 * `sessionDefaults` (Settings → Sessions), falling back to the built-ins:
 * both kinds sharing the base branch's directory. The skip toggle renders only when the profile gate is on
 * and the chosen account opted in.
 *
 * The PROJECT is retargetable here too (decision 2026-08-03), seeded from
 * `projectId` — the workspace's current project, or the one whose sidebar header
 * was right-clicked. Deliberately NOT a peer of the pickers below: it sits in
 * the description sentence as a dim inline control (SPEC §12), because it is
 * almost always already correct and a full field would read as one more decision
 * to make. Switching it re-seeds the branch state against the new repository.
 */
export function NewSessionDialog({
  projectId,
  repoId,
  open,
  kind = 'agent',
  seedAccountId,
  onOpenChange,
  onCreated,
  accountSetup,
}: {
  /** Seeds the project control; the user can retarget it. */
  projectId: string;
  /** The seed project's repository — the fallback until `useProjects` lands. */
  repoId: number;
  open: boolean;
  /** 'terminal' opens the dialog in shell mode (no account); defaults to 'agent'. */
  kind?: SessionKind;
  /** Preselects the account picker (profile panel → session on this account). */
  seedAccountId?: number;
  onOpenChange: (open: boolean) => void;
  onCreated: (session: Session) => void;
  /** An embedder can direct account setup to the shell that owns it. */
  accountSetup?: ReactNode;
}) {
  const isTerminal = kind === 'terminal';
  const profileId = useCurrentProfileId();
  const accounts = useAccounts(profileId ?? undefined);
  const settings = useProfileSettings(profileId ?? undefined);
  const repos = useRepos();
  const host = useHostInfo();
  const create = useCreateSession();

  const [project, setProject] = useState('');
  const [accountId, setAccountId] = useState<string>('');
  const [baseBranch, setBaseBranch] = useState('');
  const [separateBranch, setSeparateBranch] = useState(true);
  const [separateWorktree, setSeparateWorktree] = useState(true);
  const [branch, setBranch] = useState('');
  const [joinWorktree, setJoinWorktree] = useState('');
  const [skip, setSkip] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The project the session will land in, and the repository that follows from
  // it. The `projectId` prop only SEEDS this (see the effect below), so every
  // query downstream keys off the live choice; `repoId` covers the window before
  // the projects list arrives.
  const projects = useProjects(profileId ?? undefined);
  const pickableProjects = useMemo(
    () => (projects.data ?? []).filter((p) => !p.archived),
    [projects.data],
  );
  const effectiveProjectId = project || projectId;
  const targetProject = pickableProjects.find((p) => p.id === effectiveProjectId);
  const effectiveRepoId = targetProject?.repo_id ?? repoId;

  const repo = repos.data?.find((r) => r.id === effectiveRepoId);
  const branches = useRepoBranches(open ? effectiveRepoId : undefined);
  const worktrees = useRepoWorktrees(open ? effectiveRepoId : undefined, 0);
  const branchPreview = `leave blank for auto`;
  const account = accounts.data?.find((a) => String(a.id) === accountId);
  const gateOpen = settings.data?.allowSkipPermissions === true;
  const showSkipToggle = !isTerminal && gateOpen && account?.skip_permissions_default === true;

  const followsClone = repo?.default_base_branch === '' && !baseBranch.trim();
  const cloneBranch = worktrees.data?.worktrees.find((w) => w.is_primary)?.branch;
  const defaultBaseName =
    repo?.default_base_branch || cloneBranch || (worktrees.data ? 'main' : '');
  const baseName = baseBranch.trim() || defaultBaseName;

  // Re-seed the project each time the dialog opens: `projectId` is where the
  // gesture came from (the workspace's project, or a right-clicked sidebar
  // header), and a previous open's choice must never carry over.
  useEffect(() => {
    if (open) setProject(projectId);
  }, [open, projectId]);

  // Every git worktree already checked out on the base branch — the clone
  // itself and any puddle worktree — so a shared session can drop into one.
  const joinable = useMemo(() => {
    return (worktrees.data?.worktrees ?? [])
      .filter((w) => w.branch === baseName)
      .map((w) => ({
        path: w.path,
        is_primary: w.is_primary,
        label: w.is_primary ? `${worktreeName(w.path)} (clone)` : worktreeName(w.path),
      }));
  }, [worktrees.data, baseName]);

  // Sharing a directory is only reachable with a shared branch and the separate-
  // directory toggle off; then a specific worktree may be joined. Default to the
  // clone when it is on the branch, else the first worktree.
  const sharingDirectory = !separateBranch && !separateWorktree;
  const defaultJoin = joinable.find((j) => j.is_primary)?.path ?? joinable[0]?.path ?? '';
  const effectiveJoin = joinWorktree || defaultJoin;

  const defaultAccount = useMemo(() => {
    const preferred = settings.data?.['default_account_id'];
    return (
      accounts.data?.find((a) => a.id === seedAccountId) ??
      accounts.data?.find((a) => typeof preferred === 'number' && a.id === preferred) ??
      accounts.data?.[0]
    );
  }, [accounts.data, settings.data, seedAccountId]);
  const effectiveAccountId = accountId || (defaultAccount ? String(defaultAccount.id) : '');
  const orderedAccounts = useMemo(
    () => orderAccountPickerItems(accounts.data ?? []),
    [accounts.data],
  );

  useEffect(() => {
    if (open && seedAccountId !== undefined) setAccountId(String(seedAccountId));
  }, [open, seedAccountId]);

  // Reset the axes each time the dialog opens (or its mode or project changes),
  // seeding from the profile's per-kind defaults (Settings → Sessions). Settings
  // are read through a ref so their arrival mid-dialog never clobbers toggles
  // the user already touched — a first-ever open racing the fetch simply seeds
  // the built-ins. Retargeting the project re-seeds because the branch state
  // belongs to a repository: a base branch and a directory to join in the old
  // project mean nothing in the new one.
  const settingsRef = useRef(settings.data);
  settingsRef.current = settings.data;
  useEffect(() => {
    if (open) {
      const seed = resolveSessionSeed(isTerminal ? 'terminal' : 'agent', settingsRef.current);
      setBaseBranch(seed.baseBranch);
      setSeparateBranch(seed.separateBranch);
      setSeparateWorktree(seed.separateWorktree);
      setJoinWorktree('');
    }
  }, [open, isTerminal, effectiveProjectId]);

  // Prefill the base branch with the value an empty field would resolve to
  // (the repository's default) — the field shows what will actually be used.
  // Functional update so a late repos fetch fills only a still-empty field and
  // never overwrites something the user typed; clearing it still means "the
  // repository default", which the placeholder continues to say. Runs after the
  // re-seed above (declaration order), so a project switch refills it.
  const repoDefaultBranch = repo?.default_base_branch;
  useEffect(() => {
    if (!open || !repoDefaultBranch) return;
    setBaseBranch((prev) => (prev === '' ? repoDefaultBranch : prev));
  }, [open, effectiveProjectId, repoDefaultBranch]);

  const submit = () => {
    setError(null);
    create.mutate(
      {
        project_id: effectiveProjectId,
        ...(isTerminal
          ? { kind: 'terminal' as const }
          : { account_id: Number(effectiveAccountId) }),
        ...(baseBranch.trim() ? { base_branch: baseBranch.trim() } : {}),
        separate_branch: separateBranch,
        ...(separateBranch && branch.trim() ? { branch: branch.trim() } : {}),
        // Only meaningful without a separate branch; a new branch always gets its own dir.
        ...(!separateBranch ? { separate_worktree: separateWorktree } : {}),
        // A preview of the clone's branch must not pin the automatic choice:
        // the daemon resolves it again on creation. Explicit directory choices win.
        ...(sharingDirectory && effectiveJoin && (!followsClone || joinWorktree)
          ? { join_worktree: effectiveJoin }
          : {}),
        ...(showSkipToggle && skip ? { skip_permissions: true } : {}),
      },
      {
        onSuccess: (session) => {
          onOpenChange(false);
          setBranch('');
          setSkip(false);
          onCreated(session);
        },
        onError: (e) => setError(e.message),
      },
    );
  };

  const noun = isTerminal ? 'a shell' : 'an agent';
  const where = separateBranch
    ? `on a new branch off ${baseName || '…'}, in its own directory`
    : sharingDirectory
      ? `on ${baseName || '…'}, sharing an existing directory`
      : `on ${baseName || '…'}, in its own directory`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isTerminal ? 'New terminal' : 'New agent'}</DialogTitle>
          {/* The project rides IN the sentence rather than above the fields —
              it is nearly always already right, and a field of its own would
              present it as another decision to make (HUMANS.md). */}
          <DialogDescription>
            {isTerminal ? 'Opens' : 'Spawns'} {noun} in{' '}
            <ProjectPicker
              projects={pickableProjects}
              value={effectiveProjectId}
              onChange={setProject}
            />{' '}
            {where}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (isTerminal || effectiveAccountId) submit();
          }}
        >
          {!isTerminal && (
            <div className="flex flex-col gap-1.5">
              <Label>Account</Label>
              {accounts.data?.length === 0 ? (
                <p className="text-sm text-fg-secondary">
                  {accountSetup ?? (
                    <>
                      No accounts yet —{' '}
                      <button
                        type="button"
                        className="text-accent underline"
                        onClick={() => openSettings('accounts')}
                      >
                        add one in settings
                      </button>
                      .
                    </>
                  )}
                </p>
              ) : (
                <Select value={effectiveAccountId} onValueChange={setAccountId}>
                  <SelectTrigger>
                    <SelectValue placeholder="pick an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {orderedAccounts.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        <span>
                          {a.agent_type}/{a.label}
                        </span>
                        {!a.logged_in && (
                          <span className="ml-2 text-2xs text-warning">not logged in</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* Branch selection: base branch, and — only with a separate branch —
              the new branch name, side by side. */}
          <div className="flex gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label htmlFor="base-branch">Base branch</Label>
              <HintInput
                id="base-branch"
                placeholder={repo?.default_base_branch || 'current clone branch'}
                value={baseBranch}
                onValueChange={setBaseBranch}
                hints={(branches.data?.branches ?? [])
                  .filter((b) => b.name.toLowerCase().includes(baseBranch.trim().toLowerCase()))
                  .slice(0, 20)
                  .map((b) => ({
                    value: b.name,
                    badge:
                      b.name === defaultBaseName
                        ? 'default'
                        : b.is_session
                          ? `session: ${b.session_title ?? 'untitled'}`
                          : undefined,
                  }))}
                hintsClassName="w-max min-w-full max-w-[36rem]"
              />
              {followsClone && (
                <p className="text-xs text-fg-muted">
                  Uses the clone’s current branch when created{baseName ? ` (now ${baseName})` : ''}
                  .
                </p>
              )}
            </div>
            {separateBranch && (
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex items-baseline gap-2">
                  <Label htmlFor="session-branch">New branch</Label>
                  <span className="text-xs text-fg-muted">optional</span>
                </div>
                <Input
                  id="session-branch"
                  placeholder={branchPreview}
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </div>
            )}
          </div>

          {/* Axis 1: separate branch. Axis 2: separate directory (forced on, and
              greyed, while a separate branch is used — a new branch is always
              its own directory). */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Switch
                id="separate-branch"
                checked={separateBranch}
                onCheckedChange={(v) => {
                  setSeparateBranch(v);
                  if (v) setSeparateWorktree(true);
                }}
              />
              <Label htmlFor="separate-branch">Use separate branch</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="separate-worktree"
                checked={separateBranch ? true : separateWorktree}
                disabled={separateBranch}
                onCheckedChange={setSeparateWorktree}
              />
              <Label htmlFor="separate-worktree" className={cn(separateBranch && 'text-fg-muted')}>
                Use separate directory
              </Label>
            </div>
          </div>

          {/* Sharing a directory: pick which existing one to join. */}
          {sharingDirectory && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="join-dir">Directory to join</Label>
              {joinable.length === 0 ? (
                <p className="text-xs text-fg-muted">
                  No existing directory on{' '}
                  <span className="text-fg-secondary">{baseName || '…'}</span> — a shared one will
                  be created for later sessions to join.
                </p>
              ) : (
                <Select value={effectiveJoin} onValueChange={setJoinWorktree}>
                  <SelectTrigger id="join-dir">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* The trigger shows only the label (detail is menu-only),
                        so a deep path can never overflow the dialog; the open
                        list gets the ~-compressed path, the title the full one. */}
                    {joinable.map((j) => (
                      <SelectItem
                        key={j.path}
                        value={j.path}
                        title={j.path}
                        detail={
                          <span className="ml-auto min-w-0 truncate text-2xs text-fg-muted">
                            {tildify(j.path, host.data?.home)}
                          </span>
                        }
                      >
                        {j.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {!separateBranch && !isTerminal && (
            <p className="text-xs text-warning">
              The {isTerminal ? 'shell' : 'agent'} commits straight to{' '}
              <span>{baseName || '…'}</span>
              {sharingDirectory
                ? ' and shares its working directory with concurrent sessions — they can trample each other’s edits.'
                : '.'}
            </p>
          )}

          {showSkipToggle && (
            <div className="flex items-center gap-2 rounded-md bg-surface px-3 py-2">
              <Switch id="skip-permissions" checked={skip} onCheckedChange={setSkip} />
              <Label htmlFor="skip-permissions" className="text-warning">
                Skip permission prompts for this session
              </Label>
            </div>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={(!isTerminal && !effectiveAccountId) || create.isPending}
            >
              {isTerminal ? 'Open terminal' : 'Start agent'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Which project the session lands in — one dim word inside the header sentence,
 * plus a small chevron to say it is live (HUMANS.md: no border, a colour shift
 * on hover, and a pointer cursor). Deliberately quieter than the fields below:
 * it is seeded correctly for the gesture that opened the dialogue, so it should
 * read as a fact you CAN change rather than a choice you must make. With nothing
 * to switch to it degrades to plain text.
 */
function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: Project[];
  value: string;
  onChange: (projectId: string) => void;
}) {
  // Before the projects list lands there is a project but no name for it; say
  // so rather than flashing a wrong one.
  const label = projects.find((p) => p.id === value)?.name ?? 'this project';
  if (projects.length < 2) return <span className="text-fg-secondary">{label}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Choose the project"
          className="inline-flex items-center gap-0.5 text-fg-secondary transition-colors hover:text-fg"
        >
          {label}
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {projects.map((p) => (
          <DropdownMenuItem
            key={p.id}
            onSelect={() => onChange(p.id)}
            className={cn('truncate', p.id === value && 'text-fg')}
          >
            {p.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
