import { proxyGrantResponseSchema } from '@puddle/shared';
import { api } from '../../lib/transport/api';
import { desktopBridge } from '../../lib/desktop';

/** Obtain an application-scoped invitation using this cockpit's authorisation. */
export async function forwardingInvitation(url: URL): Promise<string> {
  const match = /^\/forward\/([^/]+)\/(\d+)$/.exec(url.pathname);
  if (!match) throw new Error('This forwarding link is invalid.');
  const body = await api('POST', '/cockpit/proxy-grant', {
    session: match[1],
    port: Number(match[2]),
    path: url.searchParams.get('path') ?? '/',
  });
  return proxyGrantResponseSchema.parse(body).url;
}

/** Desktop links leave Electron's storage behind when opened in the system browser. */
export async function openBrowserLink(uri: string): Promise<void> {
  let target = uri;
  const url = new URL(uri, window.location.href);
  if (
    desktopBridge() &&
    url.origin === window.location.origin &&
    url.pathname.startsWith('/forward/')
  ) {
    target = await forwardingInvitation(url);
  }
  // Ordinary browser tabs must open synchronously, preserving the click gesture.
  // Electron's window-open handler also accepts the asynchronous invitation URL.
  window.open(target, '_blank', 'noopener,noreferrer');
}
