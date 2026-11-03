/**
 * The CLIENT's operating system: the machine running this browser or desktop
 * shell, never the daemon host (`GET /api/host` describes that). It decides
 * keyboard conventions only — modifier names, and which modifier a shortcut
 * written for ⌘ uses — so a Windows laptop driving a Linux host still gets
 * Windows keys.
 */
export type ClientPlatform = 'mac' | 'windows' | 'other';

export function clientPlatformOf(navigatorPlatform: string): ClientPlatform {
  if (/Mac|iPhone|iPad/.test(navigatorPlatform)) return 'mac';
  if (/^Win/.test(navigatorPlatform)) return 'windows';
  return 'other';
}

/**
 * Evaluated once at import. Outside a browser (plain-Node vitest, where Node's
 * own `navigator.platform` names the machine running the tests) it is `mac`,
 * the historical behaviour, so results never depend on the test machine;
 * tests pass a platform explicitly instead.
 */
export const CLIENT_PLATFORM: ClientPlatform =
  typeof window !== 'undefined' ? clientPlatformOf(navigator.platform) : 'mac';
