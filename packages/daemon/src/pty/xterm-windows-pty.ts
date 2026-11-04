import type { ITerminalOptions } from '@xterm/headless';

/**
 * xterm's `windowsPty` option for the screen mirror of a Windows daemon's
 * PTYs: the value the browser's terminals pass (web `windowsPtyOptions`,
 * docs/windows.md decision 17), since attach replays this mirror into them.
 *
 * ConPTY repaints its own view after a resize. Attach resizes the mirror to
 * the viewer before the PTY, so a mirror that pulled lines back out of
 * scrollback on growth, as xterm does for a POSIX PTY, would have them
 * overwritten by that repaint: rows are lost or duplicated, and the cursor
 * lands below ConPTY's. Below build 21376 xterm also stops reflowing on a
 * width change, as that ConPTY does; without a build number it keeps reflow
 * on, which suits Windows 11.
 *
 * POSIX hosts get no key at all, exactly as before: xterm reads
 * `windowsPty.backend` unguarded, so an explicit `undefined` would break it.
 */
export function xtermWindowsPty(
  platform: NodeJS.Platform,
  osBuild: number | undefined,
): Pick<ITerminalOptions, 'windowsPty'> {
  if (platform !== 'win32') return {};
  return {
    windowsPty:
      osBuild === undefined ? { backend: 'conpty' } : { backend: 'conpty', buildNumber: osBuild },
  };
}
