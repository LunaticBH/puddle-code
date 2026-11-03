import { PROFILE_ICON_COLOURS } from '@puddle/shared';
import { appearanceColourClass } from '../lib/appearance/appearance-colours';
import { cn } from '../lib/utils';

/** The same compact, theme-aware swatches for profile icons and project names. */
export function ColourPicker({
  value,
  onChange,
  disabled = false,
  label = 'Colour',
}: {
  value: string | null | undefined;
  onChange: (colour: (typeof PROFILE_ICON_COLOURS)[number] | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      {[null, ...PROFILE_ICON_COLOURS].map((colour) => (
        <button
          key={colour ?? 'default'}
          type="button"
          title={colour ?? 'Default'}
          aria-label={colour ?? 'Default colour'}
          aria-pressed={(value ?? null) === colour}
          disabled={disabled}
          onClick={() => onChange(colour)}
          className={cn(
            'flex size-7 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-border/50 focus-visible:bg-border/50 disabled:cursor-default disabled:opacity-50',
            (value ?? null) === colour && 'bg-border/50',
          )}
        >
          <span
            className={cn(
              'size-3.5 rounded-full',
              colour ? cn('bg-current', appearanceColourClass(colour)) : 'bg-fg-muted',
            )}
          />
        </button>
      ))}
    </div>
  );
}
