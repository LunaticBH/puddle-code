import { useEffect, useRef, useState } from 'react';
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { toastError } from '../../../lib/transport/errors';
import type { Account, AgentType } from '@puddle/shared';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { HintInput } from '../../../components/ui/hint-input';
import { Input } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import {
  useAccounts,
  useAgents,
  useCreateAccount,
  useDeleteAccount,
  useDirSuggestions,
  useLoginAccount,
  usePatchAccount,
  useProfileSettings,
} from '../../../lib/queries/queries';
import { useDebouncedValue } from '../../../lib/hooks/use-debounced-value';
import { LoginDialog } from '../../accounts/LoginDialog';
import { useCurrentProfileId } from '../../profile/profile-store';
import { SectionTitle, SettingRow } from '../parts';

/**
 * The one way to add an account (SPEC §11). The import directory is OPTIONAL:
 * leave it blank for a fresh puddle-owned account, or point it at an existing
 * config dir to copy that in. One dialogue rather than a label field plus two
 * buttons — the two paths differ by a single optional input, so presenting them
 * as separate commands only asked the user to decide something twice.
 */
function AddAccountDialog({
  agent,
  profileId,
  onClose,
  onCreated,
}: {
  agent: AgentType;
  profileId: string;
  onClose: () => void;
  /** `imported` distinguishes the two follow-ups: log in, or say credentials may not have travelled. */
  onCreated: (account: Account, imported: boolean) => void;
}) {
  const create = useCreateAccount();
  const [label, setLabel] = useState('');
  const [dir, setDir] = useState('');
  const debouncedDir = useDebouncedValue(dir, 150);
  const suggestions = useDirSuggestions(debouncedDir);
  const importDir = dir.trim();
  // A path is only checked when one is given at all — blank is the normal case.
  const dirValid = importDir === '' || importDir.startsWith('/') || importDir.startsWith('~');
  const ready = label.trim() !== '' && dirValid;

  const submit = () => {
    if (!ready || create.isPending) return;
    create.mutate(
      {
        profile_id: profileId,
        agent_type: agent.id,
        label: label.trim(),
        ...(importDir === '' ? {} : { import_dir: importDir }),
      },
      {
        onSuccess: (account) => {
          onClose();
          onCreated(account, importDir !== '');
        },
        onError: (e) => toastError(e),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a {agent.display_name} account</DialogTitle>
          <DialogDescription>
            Accounts are isolated config dirs under this profile. Naming one is enough — Puddle
            creates it and takes you straight to {agent.display_name}&rsquo;s login. To reuse an
            account you already have on this machine, give its config directory: it is copied in and
            the original is never touched.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            autoFocus
            placeholder="label, e.g. personal"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <HintInput
            value={dir}
            onValueChange={setDir}
            placeholder={`(optional) existing config dir, e.g. ~/.claude`}
            hints={(suggestions.data?.entries ?? []).map((e) => ({ value: e.path, label: e.name }))}
          />
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready || create.isPending} onClick={submit}>
            <Plus />
            Add account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountRow({
  account,
  gateOpen,
  installed,
}: {
  account: Account;
  gateOpen: boolean;
  /** False when the agent's CLI is missing: logging in cannot possibly work. */
  installed: boolean;
}) {
  const login = useLoginAccount();
  const patch = usePatchAccount();
  const remove = useDeleteAccount();
  const [loginStream, setLoginStream] = useState<{ stream: string; hint?: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Editable label: local while typing, saved on blur/Enter, reverted on Escape.
  const [label, setLabel] = useState(account.label);
  const labelRef = useRef<HTMLInputElement>(null);
  useEffect(() => setLabel(account.label), [account.label]);

  const commitLabel = () => {
    const next = label.trim();
    if (next === account.label) return;
    if (next === '') {
      setLabel(account.label);
      return;
    }
    patch.mutate(
      { id: account.id, label: next },
      {
        onError: (e) => {
          toastError(e);
          setLabel(account.label);
        },
      },
    );
  };

  return (
    <div className="flex items-center gap-3 rounded-md bg-surface px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <input
            ref={labelRef}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') {
                setLabel(account.label);
                e.currentTarget.blur();
              }
            }}
            aria-label="Account name"
            className="-mx-1 block w-full min-w-0 truncate rounded-sm bg-transparent px-1 py-0.5 text-sm text-fg transition-colors hover:bg-elevated focus:bg-elevated focus:outline-none"
          />
          {/* The name IS the editor, but nothing said so until it was hovered —
              the pencil is the standing hint, and clicking it starts the edit. */}
          <button
            type="button"
            title="Rename account"
            onClick={() => {
              labelRef.current?.focus();
              labelRef.current?.select();
            }}
            className="shrink-0 rounded-sm p-0.5 text-fg-muted transition-colors hover:bg-elevated hover:text-fg"
          >
            <Pencil className="size-3" />
            <span className="sr-only">Rename account</span>
          </button>
        </span>
        <span className={`text-2xs ${account.logged_in ? 'text-success' : 'text-warning'}`}>
          {account.logged_in ? 'logged in' : 'not logged in'}
        </span>
      </span>
      {gateOpen && (
        <label className="flex items-center gap-2 text-xs text-fg-secondary">
          skip prompts
          <Switch
            checked={account.skip_permissions_default}
            onCheckedChange={(checked) =>
              patch.mutate(
                { id: account.id, skip_permissions_default: checked },
                { onError: (e) => toastError(e) },
              )
            }
          />
        </label>
      )}
      <Button
        size="sm"
        variant="secondary"
        disabled={login.isPending || !installed}
        onClick={() =>
          login.mutate(account.id, {
            onSuccess: (res) => setLoginStream({ stream: res.stream, hint: res.hint }),
            onError: (e) => toastError(e),
          })
        }
      >
        <KeyRound />
        {account.logged_in ? 'Re-login' : 'Login'}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7 text-fg-muted hover:text-danger"
        onClick={() => setConfirmingDelete(true)}
      >
        <Trash2 />
        <span className="sr-only">Delete account</span>
      </Button>
      {loginStream && (
        <LoginDialog
          stream={loginStream.stream}
          hint={loginStream.hint}
          label={`${account.agent_type}/${account.label}`}
          onClose={() => setLoginStream(null)}
        />
      )}
      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete <span className="text-fg">{account.label}</span>?
            </DialogTitle>
            <DialogDescription>
              Removes the account, its archived session history, and its credential directory — this
              logs the account out. Non-archived sessions block deletion.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(account.id, {
                  onSuccess: () => setConfirmingDelete(false),
                  onError: (e) => {
                    setConfirmingDelete(false);
                    toastError(e);
                  },
                })
              }
            >
              Delete account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function AccountsSection() {
  const profileId = useCurrentProfileId();
  const agents = useAgents();
  const accounts = useAccounts(profileId ?? undefined);
  const settings = useProfileSettings(profileId ?? undefined);
  const login = useLoginAccount();
  const [loginStream, setLoginStream] = useState<{
    stream: string;
    label: string;
    hint?: string;
  } | null>(null);
  const [addingTo, setAddingTo] = useState<AgentType | null>(null);

  const gateOpen = settings.data?.allowSkipPermissions === true;

  // A fresh account goes straight into the agent's login (SPEC §11); an
  // imported one may already carry credentials, so it only says so when it
  // does not — macOS keychain tokens are bound to the source path and do not
  // travel with a copy.
  const afterCreate = (account: Account, imported: boolean) => {
    if (imported) {
      if (!account.logged_in)
        toast.info('Imported without credentials — press Login to authenticate.');
      return;
    }
    login.mutate(account.id, {
      onSuccess: (res) =>
        setLoginStream({
          stream: res.stream,
          label: `${account.agent_type}/${account.label}`,
          hint: res.hint,
        }),
      onError: (e) => toastError(e),
    });
  };

  return (
    <div>
      <SectionTitle>Accounts</SectionTitle>
      {agents.data?.map((agent) => {
        const agentAccounts = accounts.data?.filter((a) => a.agent_type === agent.id) ?? [];
        // Older daemons omit `available`; absent means "cannot tell", so allow.
        const installed = agent.available !== false;
        return (
          <div key={agent.id} className="mb-5">
            <SettingRow
              label={agent.display_name}
              description={
                installed
                  ? 'Accounts are initialised in config dirs owned by this profile.'
                  : `No ${agent.binary ?? agent.id} on the daemon’s PATH. Install it or add its directory to the agent search path in Sessions.`
              }
              className="py-1"
            >
              <span className="text-2xs text-fg-muted">{agent.id}</span>
            </SettingRow>
            <div className="flex flex-col gap-1.5">
              {agentAccounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  gateOpen={gateOpen && agent.capabilities.skip_permissions}
                  installed={installed}
                />
              ))}
              <div className="flex">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!installed}
                  onClick={() => setAddingTo(agent)}
                >
                  <Plus />
                  Add account
                </Button>
              </div>
            </div>
          </div>
        );
      })}
      {loginStream && (
        <LoginDialog
          stream={loginStream.stream}
          label={loginStream.label}
          hint={loginStream.hint}
          onClose={() => setLoginStream(null)}
        />
      )}
      {addingTo !== null && profileId !== null && (
        <AddAccountDialog
          agent={addingTo}
          profileId={profileId}
          onClose={() => setAddingTo(null)}
          onCreated={afterCreate}
        />
      )}
    </div>
  );
}
