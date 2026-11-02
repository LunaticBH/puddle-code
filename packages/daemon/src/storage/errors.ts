/** Capacity failures are recoverable at persistence boundaries, never globally. */
export function isStorageFull(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return ['ENOSPC', 'EDQUOT', 'SQLITE_FULL'].includes(String(error.code));
}

export function isDatabaseFull(error: unknown): boolean {
  return isStorageFull(error) && (error as { code: string }).code === 'SQLITE_FULL';
}
