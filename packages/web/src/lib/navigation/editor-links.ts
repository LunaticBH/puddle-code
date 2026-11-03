import { hostPathStyle } from '@puddle/shared';
import { clientSettings } from '../settings/client-settings';
import { localValue } from '../persistence/local-store';

/**
 * "Open in editor" deep links (SPEC §7): VS Code and Cursor both understand
 * the same `vscode-remote` remote-authority scheme (Cursor is a VS Code
 * fork), so only the URI scheme itself (`vscode:` vs `cursor:`) varies.
 */
export type Editor = 'vscode' | 'cursor';

/**
 * Percent-encode a filesystem path for use inside a URI, keeping the slashes.
 * `encodeURI` is not enough: it leaves `#` and `?` raw (they're in its
 * reserved set), and the OS URL handler would truncate the path at the first
 * one. Encoding each segment with `encodeURIComponent` escapes space/#/?/%
 * while the rejoining keeps the path structure intact.
 */
function encodePathForUri(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * An `ssh-remote+` authority keeps `@` and `:` literal (`user@host:port`) —
 * VS Code parses the raw authority, so `encodeURIComponent` (which turns `@`
 * into `%40` and `:` into `%3A`) would break it. Escape only the characters
 * that break URI parsing itself: space, `#`, `?`, and `%`.
 */
function escapeHostForUri(host: string): string {
  return host.replace(/[%#? ]/g, (c) => encodeURIComponent(c));
}

/**
 * A Windows path in the URI form VS Code expects (`/C:/Users/alice/proj`):
 * forward slashes, a leading `/`, and the drive colon kept literal. A UNC
 * path keeps its double slash (`//server/share/proj`), which VS Code reads
 * as a share.
 */
function encodeWindowsPathForUri(path: string): string {
  const slashed = path.replaceAll('\\', '/');
  const drive = /^([A-Za-z]:)(\/.*)?$/.exec(slashed);
  if (drive) return `/${drive[1]}${encodePathForUri(drive[2] ?? '/')}`;
  return encodePathForUri(slashed);
}

/**
 * `worktreePath` is always absolute (`/Users/alice/proj`), so plain
 * concatenation after `file` produces the correct single-slash shape
 * (`vscode://file/Users/alice/proj`) without an extra separator. A Windows
 * host's `C:\Users\alice\proj` becomes `vscode://file/C:/Users/alice/proj`.
 */
export function editorDeepLink(
  editor: Editor,
  worktreePath: string,
  sshHost: string | null,
): string {
  const path =
    hostPathStyle(worktreePath) === 'win32'
      ? encodeWindowsPathForUri(worktreePath)
      : encodePathForUri(worktreePath);
  if (sshHost) {
    return `${editor}://vscode-remote/ssh-remote+${escapeHostForUri(sshHost)}${path}`;
  }
  return `${editor}://file${path}`;
}

/**
 * The CLI starts sending `?host=` at boot in Phase 6; until then (or for a
 * manual `ssh -L` user it will never cover) the client setting wins. The
 * free-text setting is normalised the same way `parseHostParam` normalises
 * the boot param: trimmed, with blank collapsing to unset.
 */
export function resolveEditorHost(settingHost: string, storedHost: string | null): string | null {
  const setting = settingHost.trim();
  if (setting) return setting;
  if (storedHost) return storedHost;
  return null;
}

/** Captured once at boot from `?host=`, kept across reloads (`bootstrapToken`'s sibling). */
export const hostParamStore = localValue('puddle.host');

export function editorLinkHost(): string | null {
  return resolveEditorHost(clientSettings().editorLinkSshHost, hostParamStore.get());
}

/** Pure extraction so it's testable without a DOM; trims and treats blank as absent. */
export function parseHostParam(search: string): string | null {
  const host = new URLSearchParams(search).get('host')?.trim();
  return host ? host : null;
}

/**
 * Pure decision core for `captureHostParam`, testable without a DOM: what the
 * stored host should become given this boot's URL. A CLI launch always
 * carries `#invite=`; when it carries no `?host=` it was `puddle launch` —
 * LOCAL mode — so a host stored by yesterday's `puddle launch` on the same
 * origin must be cleared, or the window would still think it is tunnelled.
 * A boot with neither (a plain reload) keeps whatever is stored.
 */
export function nextStoredHost(search: string, hash: string, stored: string | null): string | null {
  const host = parseHostParam(search);
  if (host) return host;
  if (/[#&](?:invite|token)=/.test(hash)) return null;
  return stored;
}

/**
 * Mirrors `bootstrapToken` (`src/lib/auth.ts`): read `?host=` once, store it,
 * and strip it from the address bar via `history.replaceState` (the CLI's
 * connect-time param shouldn't linger in history or survive a copy-paste of
 * the URL). MUST run before `bootstrapToken`, which strips the `#invite=`
 * fragment this function reads as the local-mode signal.
 */
export function captureHostParam(): void {
  const next = nextStoredHost(window.location.search, window.location.hash, hostParamStore.get());
  hostParamStore.set(next);
  if (parseHostParam(window.location.search) !== null) {
    const url = new URL(window.location.href);
    url.searchParams.delete('host');
    history.replaceState(null, '', url);
  }
}
