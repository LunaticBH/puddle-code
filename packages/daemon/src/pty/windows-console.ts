/**
 * Facts about Windows pseudoconsoles (ConPTY) that the rest of the daemon
 * needs to interpret PTY output and exits. Verified with node-pty 1.1.0 on
 * the inbox ConPTY of Windows 11 build 26200.
 */

import { release } from 'node:os';

/**
 * The Windows build number, the third part of `os.release()` (`10.0.26200`),
 * which selects xterm's ConPTY workarounds. `GET /api/host` reports it to the
 * browser's terminals and the daemon's screen mirror reads it here, so both
 * emulate the same ConPTY. Undefined on other platforms.
 */
export function windowsBuildNumber(
  platform: NodeJS.Platform = process.platform,
  osRelease?: string,
): number | undefined {
  if (platform !== 'win32') return undefined;
  const build = Number((osRelease ?? release()).split('.')[2]);
  return Number.isInteger(build) && build >= 0 ? build : undefined;
}

/**
 * STATUS_CONTROL_C_EXIT (0xC000013A): how a console process ends when its
 * pseudoconsole is closed, which is what `kill()` does, or when it takes the
 * default Ctrl+C action. It is the Windows counterpart of a POSIX death by
 * SIGHUP or SIGINT, which node-pty reports there as exit code 0.
 */
export const STATUS_CONTROL_C_EXIT = -1073741510;

/**
 * Whether `title` is the one inbox ConPTY sets by itself: the full path of
 * the executable it started (`C:\WINDOWS\SYSTEM32\cmd.exe`). It names no
 * session, so it must not become one's terminal-title name.
 */
export function isConsoleHostTitle(title: string): boolean {
  return /^(?:[A-Za-z]:\\|\\\\).*\.exe$/i.test(title);
}

/** An exit code as Windows tools print it: NTSTATUS values in hexadecimal. */
export function windowsExitCodeLabel(code: number): string {
  return code < 0 ? `0x${(code >>> 0).toString(16).toUpperCase()}` : String(code);
}
