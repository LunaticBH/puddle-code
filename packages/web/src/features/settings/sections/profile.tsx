import { useEffect, useState } from 'react';
import { toastError } from '../../../lib/transport/errors';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import {
  useAccounts,
  useDeleteProfile,
  usePatchProfile,
  usePatchProfileSettings,
  useProfileSettings,
  useProfiles,
} from '../../../lib/queries/queries';
import { closeSettings } from '../../../lib/navigation/hash-route';
import { profileStore, useCurrentProfileId } from '../../profile/profile-store';
import { SectionTitle, SettingRow } from '../parts';
import { ProfileAppearance } from './profile-appearance';

const NONE = '__none__';

export function ProfileSection() {
  const profileId = useCurrentProfileId();
  const profiles = useProfiles();
  const profile = profiles.data?.find((p) => p.id === profileId);
  const accounts = useAccounts(profileId ?? undefined);
  const settings = useProfileSettings(profileId ?? undefined);
  const patchProfile = usePatchProfile();
  const patchSettings = usePatchProfileSettings(profileId ?? '');
  const deleteProfile = useDeleteProfile();

  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [typedName, setTypedName] = useState('');
  useEffect(() => {
    if (profile) {
      setName(profile.name);
      setPrefix(profile.branch_prefix);
    }
  }, [profile]);

  if (!profile) return null;
  const defaultAccount = settings.data?.['default_account_id'];

  return (
    <div>
      <SectionTitle>Profile</SectionTitle>
      <SettingRow
        label="Name"
        description="Letters, digits, dot, underscore and hyphen."
        htmlFor="profile-name"
      >
        <Input
          id="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-44"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={name === profile.name || name.trim() === '' || patchProfile.isPending}
          onClick={() =>
            patchProfile.mutate({ id: profile.id, name }, { onError: (e) => toastError(e) })
          }
        >
          Save
        </Button>
      </SettingRow>
      <SettingRow
        label="Branch prefix"
        description="Session branches become <prefix><slug(title)>."
        htmlFor="branch-prefix"
      >
        {/* Empty saves as literally no prefix — the placeholder must say so,
            not advertise a default that would not be applied. */}
        <Input
          id="branch-prefix"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          placeholder="no prefix"
          className="w-44"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={prefix === profile.branch_prefix || patchProfile.isPending}
          onClick={() =>
            patchProfile.mutate(
              { id: profile.id, branch_prefix: prefix },
              { onError: (e) => toastError(e) },
            )
          }
        >
          Save
        </Button>
      </SettingRow>
      <ProfileAppearance profile={profile} />
      <SettingRow label="Default account" description="Preselected in the new-session modal.">
        <Select
          value={typeof defaultAccount === 'number' ? String(defaultAccount) : NONE}
          onValueChange={(value) =>
            patchSettings.mutate(
              { default_account_id: value === NONE ? null : Number(value) },
              { onError: (e) => toastError(e) },
            )
          }
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>First available</SelectItem>
            {accounts.data?.map((account) => (
              <SelectItem key={account.id} value={String(account.id)}>
                <span>
                  {account.agent_type}/{account.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        label="Delete profile"
        description="Non-archived sessions block deletion."
        className="mt-4"
      >
        <Button variant="danger" size="sm" onClick={() => setConfirmingDelete(true)}>
          Delete…
        </Button>
      </SettingRow>

      <Dialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmingDelete(false);
            setTypedName('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete profile <span className="text-fg">{profile.name}</span>?
            </DialogTitle>
            <DialogDescription>
              Everything this profile owns goes with it: projects, workspace layouts, accounts and
              their credential directories, and archived session history. Branches, repositories,
              and terminal logs on disk are untouched. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delete-confirm-name">
              Type <span className="text-fg">{profile.name}</span> to confirm
            </Label>
            <Input
              id="delete-confirm-name"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmingDelete(false);
                setTypedName('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={typedName !== profile.name || deleteProfile.isPending}
              onClick={() =>
                deleteProfile.mutate(profile.id, {
                  onSuccess: () => {
                    closeSettings();
                    profileStore.set(null); // back to the picker
                  },
                  onError: (e) => {
                    setConfirmingDelete(false);
                    setTypedName('');
                    toastError(e);
                  },
                })
              }
            >
              Delete profile
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
