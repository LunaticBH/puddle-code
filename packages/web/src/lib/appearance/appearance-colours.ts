/** Shared profile/project palette, entirely derived from the active theme. */
const COLOUR_CLASSES: Record<string, string> = {
  navy: 'text-fg',
  gold: 'text-fg-gold',
  blue: 'text-icon-blue',
  green: 'text-icon-green',
  amber: 'text-icon-amber',
  red: 'text-icon-red',
  violet: 'text-icon-violet',
  cyan: 'text-icon-cyan',
  accent: 'text-accent',
};

/** Unknown or unset keys inherit the surrounding label's usual styling. */
export function appearanceColourClass(colour: string | null | undefined): string {
  return (colour && COLOUR_CLASSES[colour]) || '';
}
