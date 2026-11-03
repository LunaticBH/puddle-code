import { useSyncExternalStore } from 'react';
import { localValue } from '../../lib/persistence/local-store';

/** The selected profile — identity, not auth (SPEC §11); remembered per browser. */
export const profileStore = localValue('puddle.profile-id');

export function useCurrentProfileId(): string | null {
  const raw = useSyncExternalStore(profileStore.subscribe, profileStore.get);
  // Pre-hex ids (integers) fail this and fall back to the picker.
  return raw !== null && /^[0-9a-f]{10}$/.test(raw) ? raw : null;
}

export function selectProfile(id: string): void {
  // Selecting a profile lands on ITS dashboard (fixed 2026-08-06). The picker
  // renders INSTEAD of the router (App.tsx), so the previous profile's URL —
  // typically /project/<its project> — was still the address when the router
  // mounted, and the workspace binds a project route to the project's OWNING
  // profile: a freshly created profile appeared to have inherited the old
  // profile's projects, sessions, and layout wholesale. The router is not
  // mounted here, so reset the address directly before the store flips.
  if (window.location.pathname !== '/') window.history.replaceState(null, '', '/');
  profileStore.set(id);
}
