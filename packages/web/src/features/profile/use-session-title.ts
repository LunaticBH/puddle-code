import { useCallback } from 'react';
import { useProfileSettings } from '../../lib/queries/queries';
import { renderSessionTitle, type TitleSession } from '../../lib/session-display';
import { useCurrentProfileId } from './profile-store';

/**
 * A renderer for session tab labels bound to the current profile's
 * `tabTitleTemplate` (SPEC §4). The whole app is scoped to one profile, so a
 * single template applies to every session on screen. Returns a stable callback
 * usable per row inside a list; before the settings load it renders with the
 * built-in default (`${name}`), so labels never flash empty.
 */
export function useSessionTitleRenderer(): (session: TitleSession) => string {
  const profileId = useCurrentProfileId();
  const settings = useProfileSettings(profileId ?? undefined);
  const template = settings.data?.tabTitleTemplate;
  return useCallback((session: TitleSession) => renderSessionTitle(session, template), [template]);
}
