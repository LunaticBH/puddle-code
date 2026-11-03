/**
 * Terminal localhost-URL rewriting (SPEC §7): in SSH mode a URL an agent
 * prints — `http://localhost:5173/` — points at the HOST machine, which the
 * client's browser cannot reach directly. Rewrite it to a reusable trusted
 * cockpit landing page, which obtains an invitation for the isolated proxy
 * origin (SPEC §2). Local mode returns the URI untouched.
 */

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function rewriteTerminalUri(uri: string, sessionId: string, inSshMode: boolean): string {
  if (!inSshMode) return uri;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return uri;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return uri;
  if (!LOCAL_HOSTNAMES.has(url.hostname)) return uri;
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
  return `/forward/${sessionId}/${port}?path=${encodeURIComponent(url.pathname + url.search + url.hash)}`;
}
