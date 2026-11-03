/** The exact account label shown by the new-agent picker. */
export function accountPickerLabel(account: { agent_type: string; label: string }): string {
  return `${account.agent_type}/${account.label}`;
}

/**
 * Return a sorted copy for the picker. The API order remains untouched because
 * it still determines the legacy fallback account when no profile default is
 * configured; this helper changes presentation only.
 */
export function orderAccountPickerItems<T extends { agent_type: string; label: string }>(
  accounts: readonly T[],
): T[] {
  return [...accounts].sort((a, b) =>
    accountPickerLabel(a).localeCompare(accountPickerLabel(b), undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  );
}
