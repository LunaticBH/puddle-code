import { useState } from 'react';
import { DEFAULT_BRANCH_PREFIX } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { useCreateProfile, useProfiles } from '../../lib/queries/queries';
import { cn } from '../../lib/utils';
import { ProfileGlyph, profileColourClass } from './ProfileGlyph';
import { selectProfile } from './profile-store';

/**
 * First-load create-or-select gate (SPEC §11). Boxless (HUMANS.md): plain
 * text rows on the ground, generous spacing, hover feedback by fill only.
 */
export function ProfilePicker() {
  const profiles = useProfiles();
  const create = useCreateProfile();
  const [name, setName] = useState('');
  // Prefilled with the default it would otherwise silently become: the field
  // always shows what will be stored, and clearing it honestly means NO prefix.
  const [branchPrefix, setBranchPrefix] = useState(DEFAULT_BRANCH_PREFIX);

  const submit = () => {
    if (!name.trim()) return;
    create.mutate(
      { name: name.trim(), branch_prefix: branchPrefix.trim() },
      { onSuccess: (profile) => selectProfile(profile.id) },
    );
  };

  const hasProfiles = (profiles.data?.length ?? 0) > 0;

  return (
    <div className="flex min-h-screen items-center justify-center bg-ground">
      <div className="flex w-full max-w-md flex-col gap-10 px-8 pb-16">
        <div className="flex flex-col gap-2">
          <h1 className="font-mono text-2xl font-semibold text-fg">Puddle</h1>
          <p className="text-sm text-fg-secondary">Who is working?</p>
        </div>

        {hasProfiles && (
          <div className="flex flex-col">
            {profiles.data!.map((profile) => (
              <button
                key={profile.id}
                onClick={() => selectProfile(profile.id)}
                className="flex items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-elevated active:bg-border/70"
              >
                <ProfileGlyph icon={profile.icon} colour={profile.icon_colour} className="size-5" />
                <span
                  className={cn('text-base', profileColourClass(profile.icon_colour) || 'text-fg')}
                >
                  {profile.name}
                </span>
                {profile.branch_prefix && (
                  <span className="ml-auto text-2xs text-fg-muted">{profile.branch_prefix}…</span>
                )}
              </button>
            ))}
          </div>
        )}

        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {hasProfiles && (
            <p className="text-2xs font-medium uppercase tracking-wide text-fg-muted">
              or create a profile
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="profile-name">Name</Label>
            <Input
              id="profile-name"
              placeholder="e.g. alice"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-10"
              autoFocus={!hasProfiles}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branch-prefix">Branch prefix</Label>
            <Input
              id="branch-prefix"
              placeholder="no prefix"
              value={branchPrefix}
              onChange={(e) => setBranchPrefix(e.target.value)}
              className="h-10"
            />
          </div>
          {create.error && <p className="text-xs text-danger">{create.error.message}</p>}
          <Button
            type="submit"
            size="lg"
            className="self-start px-6"
            disabled={!name.trim() || create.isPending}
          >
            Create profile
          </Button>
        </form>
      </div>
    </div>
  );
}
