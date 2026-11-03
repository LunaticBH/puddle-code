import { UserRound } from 'lucide-react';
import { cn } from '../../lib/utils';
import { PROFILE_ICON_BY_NAME } from './profile-icons';
import { appearanceColourClass as profileColourClass } from '../../lib/appearance/appearance-colours';

export { profileColourClass };

/**
 * A profile's chosen glyph in its chosen theme colour (SPEC §11). The icon comes
 * from the curated, statically-imported set (`profile-icons.ts`) — no lazy
 * loading — so an absent or unrecognised name falls back to the person glyph.
 */
export function ProfileGlyph({
  icon,
  colour,
  className,
}: {
  icon: string | null | undefined;
  colour: string | null | undefined;
  className?: string;
}) {
  // No chosen colour → a neutral grey glyph (the "Default" swatch), NOT the
  // navy heading ink; `navy` is its own explicit choice.
  const cls = cn(
    'size-4 shrink-0',
    colour ? profileColourClass(colour) : 'text-fg-muted',
    className,
  );
  const Icon = (icon && PROFILE_ICON_BY_NAME[icon]) || UserRound;
  return <Icon className={cls} />;
}
