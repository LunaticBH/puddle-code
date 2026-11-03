import { useState } from 'react';
import { KeyRound, Plus, Settings2 } from 'lucide-react';
import { toastError } from '../../lib/transport/errors';
import type { Account } from '@puddle/shared';
import { InlineLabelEdit, editOnDoubleClick } from '../../components/inline-label-edit';
import { Button, buttonVariants } from '../../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { openSettings } from '../../lib/navigation/hash-route';
import {
  useAccountUsage,
  useAccounts,
  useAgents,
  useLoginAccount,
  usePatchProfile,
  useProfiles,
} from '../../lib/queries/queries';
import { LoginDialog } from '../accounts/LoginDialog';
import { useNewSession } from '../shell/new-session-context';
import { ProfileGlyph, profileColourClass } from './ProfileGlyph';
import { profileStore, useCurrentProfileId } from './profile-store';
import { UsageBar } from './UsageBar';

/** Compact token count: 12345 → 12.3k, 4200000 → 4.2M. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function relativeTime(iso: string | null): string {
  if (iso === null) return 'never';
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * One account row: a status dot, the label, usage summary, and the primary
 * action — logged out → sign in; logged in inside a project → new agent on
 * this account. Rows are clickable in their entirety.
 */
function AccountRow({
  account,
  onLogin,
  onStartSession,
  installed = true,
}: {
  account: Account;
  onLogin: () => void;
  onStartSession: (() => void) | null;
  /** False when the agent's CLI is missing: neither action can succeed. */
  installed?: boolean;
}) {
  const usage = useAccountUsage(account.id);
  const action = account.logged_in ? onStartSession : installed ? onLogin : null;
  const subscription = usage.data?.subscription;

  return (
    <div className="rounded-md px-2 py-2 transition-colors hover:bg-elevated">
      <button
        type="button"
        disabled={action === null}
        onClick={() => action?.()}
        className="flex w-full items-center gap-3 text-left disabled:cursor-default"
      >
        <span
          className={`size-2 shrink-0 rounded-full ${account.logged_in ? 'bg-success' : 'bg-idle'}`}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg">{account.label}</span>
          <span className="block text-2xs text-fg-muted">
            {account.logged_in ? 'logged in' : 'logged out'}
            {usage.data && (
              <>
                {' · '}
                {usage.data.session_count} session{usage.data.session_count === 1 ? '' : 's'}
                {usage.data.active_session_count > 0 &&
                  ` (${usage.data.active_session_count} active)`}
                {' · '}last {relativeTime(usage.data.last_activity_at)}
              </>
            )}
          </span>
          {usage.data?.agent_usage && (
            <span className="block text-2xs text-fg-muted">
              {compact(usage.data.agent_usage.input_tokens)} in ·{' '}
              {compact(usage.data.agent_usage.output_tokens)} out ·{' '}
              {compact(usage.data.agent_usage.cache_read_input_tokens)} cached ·{' '}
              {usage.data.agent_usage.message_count} msgs
            </span>
          )}
          {usage.data?.live_usage?.context_used_percentage != null && (
            <span className="mt-1 block">
              <UsageBar
                label="context"
                percentage={usage.data.live_usage.context_used_percentage}
              />
            </span>
          )}
        </span>
        <span className="shrink-0 text-2xs text-fg-muted">
          {!installed ? (
            'unavailable'
          ) : account.logged_in ? (
            onStartSession ? (
              'new agent'
            ) : (
              ''
            )
          ) : (
            <span className="flex items-center gap-1 text-warning">
              <KeyRound className="size-3" />
              sign in
            </span>
          )}
        </span>
      </button>

      {/* Subscription rate-limit windows, from the agent's own CLI —
          credential-free, so they simply appear when available. */}
      {subscription != null && subscription.windows.length > 0 && (
        <div className="mt-2 flex flex-col gap-1 pl-5">
          {subscription.windows.map((w) => (
            <UsageBar
              key={w.key}
              label={w.label}
              percentage={w.used_percentage}
              hint={w.resets != null ? `resets ${w.resets}` : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The profile panel: its own top-bar trigger (the profile's name), opening an
 * anchored popover beneath it with accounts grouped by agent type — status,
 * usage, actions. Unlike ⌘K and settings, this never takes the centre stage.
 *
 * A DOUBLE-click on the name renames the profile in place (the same field
 * Settings → Profile offers; a clashing name is a 409 and surfaces as a toast).
 * The first click of that double-click has already opened the panel, so entering
 * the editor closes it again — the name is the trigger, and it must not sit
 * under an open popover while being typed into.
 */
export function ProfilePanel() {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const profileId = useCurrentProfileId();
  const profiles = useProfiles();
  const patchProfile = usePatchProfile();
  const currentProfile = profiles.data?.find((p) => p.id === profileId);
  const accounts = useAccounts(profileId ?? undefined);
  const agents = useAgents();
  const login = useLoginAccount();
  const { open: openNewSession, handler } = useNewSession();
  const [loginStream, setLoginStream] = useState<{ stream: string; label: string } | null>(null);

  const startLogin = (account: Account) =>
    login.mutate(account.id, {
      onSuccess: (res) =>
        setLoginStream({ stream: res.stream, label: `${account.agent_type}/${account.label}` }),
      onError: (e) => toastError(e),
    });

  const startSession = (account: Account) => {
    setOpen(false);
    openNewSession({ accountId: account.id });
  };

  const commitName = (value: string) => {
    setRenaming(false);
    const next = value.trim();
    if (!profileId || !next || next === currentProfile?.name) return;
    patchProfile.mutate({ id: profileId, name: next }, { onError: (e) => toastError(e) });
  };

  // The trigger's own row, minus the popover, while the name is being typed.
  const triggerClassName = 'font-sans compact:h-7 compact:px-1.5';
  if (renaming && currentProfile) {
    return (
      <div
        className={buttonVariants({ variant: 'ghost', size: 'sm', className: triggerClassName })}
      >
        <ProfileGlyph icon={currentProfile.icon} colour={currentProfile.icon_colour} />
        <InlineLabelEdit
          initial={currentProfile.name}
          maxLength={100}
          fitContent
          className={profileColourClass(currentProfile.icon_colour)}
          onCommit={commitName}
          onCancel={() => setRenaming(false)}
        />
      </div>
    );
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              {/* compact: tighter padding, matching the icon buttons beside it (§12). */}
              <Button variant="ghost" size="sm" className={triggerClassName}>
                <ProfileGlyph icon={currentProfile?.icon} colour={currentProfile?.icon_colour} />
                <span
                  className={profileColourClass(currentProfile?.icon_colour)}
                  {...editOnDoubleClick(() => {
                    setOpen(false);
                    setRenaming(true);
                  })}
                >
                  {currentProfile?.name ?? '…'}
                </span>
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Profile</TooltipContent>
        </Tooltip>
        <PopoverContent className="w-[28rem] max-w-[calc(100vw-1rem)]">
          <div className="flex flex-col gap-4">
            {(agents.data ?? []).map((agent) => {
              const forAgent = accounts.data?.filter((a) => a.agent_type === agent.id) ?? [];
              if (forAgent.length === 0) return null;
              // Older daemons omit `available`; absent means "cannot tell".
              const installed = agent.available !== false;
              return (
                <div key={agent.id} className="flex flex-col gap-0.5">
                  <span className="px-2 text-2xs font-medium uppercase tracking-wide text-fg-muted">
                    {agent.display_name}
                    {!installed && (
                      <span className="ml-2 normal-case tracking-normal text-fg-muted">
                        not installed — no {agent.binary ?? agent.id} on PATH
                      </span>
                    )}
                  </span>
                  {forAgent.map((account) => (
                    <AccountRow
                      key={account.id}
                      account={account}
                      onLogin={() => startLogin(account)}
                      // A session can only start inside a workspace, and neither
                      // action can work without the agent's CLI.
                      onStartSession={handler && installed ? () => startSession(account) : null}
                      installed={installed}
                    />
                  ))}
                </div>
              );
            })}
            {accounts.data?.length === 0 && (
              <p className="px-2 text-sm text-fg-muted">No accounts yet — add one in settings.</p>
            )}
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                openSettings('accounts');
              }}
            >
              <Plus />
              Add account
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => {
                setOpen(false);
                profileStore.set(null); // back to the picker
              }}
            >
              <Settings2 />
              Switch profile
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {loginStream && (
        <LoginDialog
          stream={loginStream.stream}
          label={loginStream.label}
          onClose={() => setLoginStream(null)}
        />
      )}
    </>
  );
}
