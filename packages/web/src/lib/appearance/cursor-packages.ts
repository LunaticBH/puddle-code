/**
 * Cursor-package registry. The id is the persisted value; the label is the
 * Appearance-settings copy. A package's renderer lives under features/cursor.
 */
export const CURSOR_PACKAGES = [
  { id: 'system', label: 'System' },
  { id: 'rangefinder', label: 'Rangefinder' },
  { id: 'drafting', label: 'Drafting' },
  { id: 'invert', label: 'Invert' },
] as const;

export type CursorPackageId = (typeof CURSOR_PACKAGES)[number]['id'];

export const DEFAULT_CURSOR_PACKAGE: CursorPackageId = 'system';

export function normaliseCursorPackage(value: unknown): CursorPackageId {
  return CURSOR_PACKAGES.some((cursorPackage) => cursorPackage.id === value)
    ? (value as CursorPackageId)
    : DEFAULT_CURSOR_PACKAGE;
}
