import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * The Puddle.exe an in-app update may replace: only a per-user NSIS
 * installation, recognised by the uninstaller electron-builder places beside
 * it. An unpacked copy elsewhere is never handed to the installer.
 */
export function windowsUpdateTarget(
  execPath: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  return exists(win32.join(win32.dirname(execPath), 'Uninstall Puddle.exe')) ? execPath : null;
}
