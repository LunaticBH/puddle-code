import type { ITerminalOptions } from '@xterm/xterm';
import type { HostPathStyle } from '@puddle/shared';

/**
 * xterm's `windowsPty` option for the HOST's PTY (xterm 6.0.0). A Windows
 * daemon's PTYs are ConPTY, which repaints the screen with its own view after
 * a resize: told so, xterm adds blank rows on growth instead of pulling lines
 * back out of scrollback, which would otherwise duplicate or lose rows.
 *
 * `osBuild` is the host's Windows build number (`GET /api/host`, protocol
 * 25.7). xterm uses it to pick its ConPTY workarounds: below build 21376
 * (Windows 10) it turns reflow off and applies its legacy wrap heuristics.
 * Without it xterm keeps reflow on, which suits Windows 11.
 *
 * POSIX hosts get no key at all, exactly as before: xterm reads
 * `windowsPty.backend` unguarded, so an explicit `undefined` would break it.
 */
export function windowsPtyOptions(
  style: HostPathStyle,
  osBuild?: number,
): Pick<ITerminalOptions, 'windowsPty'> {
  if (style !== 'win32') return {};
  return {
    windowsPty:
      osBuild === undefined ? { backend: 'conpty' } : { backend: 'conpty', buildNumber: osBuild },
  };
}
