import { browserBootstrapResponseSchema } from '@puddle/shared';
import { localValue } from '../persistence/local-store';

/** Origin-scoped browser credential. Daemon credentials are never accepted here. */
export const tokenStore = localValue('puddle.browser-authorisation');

export async function bootstrapToken(): Promise<void> {
  localStorage.removeItem('puddle.token');
  const params = new URLSearchParams(window.location.hash.slice(1));
  const invitation = params.get('invite');
  if (params.has('invite') || params.has('token')) {
    const url = new URL(window.location.href);
    url.hash = '';
    history.replaceState(null, '', url);
  }
  if (!invitation) return;
  try {
    const response = await fetch('/cockpit/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invitation }),
    });
    if (!response.ok) return;
    tokenStore.set(browserBootstrapResponseSchema.parse(await response.json()).credential);
  } catch {
    /* A failed invitation never discards an existing browser authorisation. */
  }
}

/** Only explicit browser rejection clears login; upstream outages preserve it. */
export function clearToken(): void {
  tokenStore.set(null);
}
