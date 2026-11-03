import { useState } from 'react';
import { toastError } from '../../../lib/transport/errors';
import type { Profile } from '@puddle/shared';
import { ColourPicker } from '../../../components/colour-picker';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { usePatchProfile } from '../../../lib/queries/queries';
import { cn } from '../../../lib/utils';
import { ProfileGlyph } from '../../profile/ProfileGlyph';
import { PROFILE_ICONS } from '../../profile/profile-icons';
import { SettingRow } from '../parts';

/**
 * Profile appearance (SPEC §11): pick an icon from a small curated set and any
 * theme colour for the profile's glyph, shown wherever the profile appears (top
 * bar, picker). The set is static (no lazy loading, no search, no scroll).
 */
export function ProfileAppearance({ profile }: { profile: Profile }) {
  const patch = usePatchProfile();
  const [open, setOpen] = useState(false);

  const setIcon = (icon: string | null) => {
    patch.mutate({ id: profile.id, icon }, { onError: (e) => toastError(e) });
    setOpen(false);
  };
  const setColour = (icon_colour: string | null) =>
    patch.mutate({ id: profile.id, icon_colour }, { onError: (e) => toastError(e) });

  return (
    <>
      <SettingRow label="Icon">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex size-9 items-center justify-center rounded-md text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
            >
              <ProfileGlyph icon={profile.icon} colour={profile.icon_colour} className="size-5" />
              <span className="sr-only">Choose an icon</span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <div className="grid grid-cols-8 gap-1">
              <button
                type="button"
                title="Default"
                onClick={() => setIcon(null)}
                className={cn(
                  'flex h-8 items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-elevated hover:text-fg',
                  !profile.icon && 'bg-elevated text-fg',
                )}
              >
                <ProfileGlyph icon={null} colour={null} className="size-4" />
              </button>
              {PROFILE_ICONS.map(({ name, Icon }) => (
                <button
                  key={name}
                  type="button"
                  title={name}
                  onClick={() => setIcon(name)}
                  className={cn(
                    'flex h-8 items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-elevated hover:text-fg',
                    profile.icon === name && 'bg-elevated text-fg',
                  )}
                >
                  <Icon className="size-4" />
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </SettingRow>

      <SettingRow label="Icon colour">
        <ColourPicker value={profile.icon_colour} onChange={setColour} label="Icon colour" />
      </SettingRow>
    </>
  );
}
