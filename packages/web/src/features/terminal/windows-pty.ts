import type { ITerminalOptions } from '@xterm/xterm';
import type { HostPathStyle } from '@puddle/shared';

/**
 * xterm's `windowsPty` option for the HOST's PTY (xterm 6.0.0). A Windows
 * daemon's PTYs are ConPTY, which repaints the screen with its own view after
 * a resize: told so, xterm adds blank rows on growth instead of pulling lines
 * back out of scrollback, which would otherwise duplicate or lose rows. No
 * build number is known, so xterm keeps reflow on and its legacy wrap
 * heuristics off (what it does for ConPTY from build 21376).
 *
 * POSIX hosts get no key at all, exactly as before: xterm reads
 * `windowsPty.backend` unguarded, so an explicit `undefined` would break it.
 */
export function windowsPtyOptions(style: HostPathStyle): Pick<ITerminalOptions, 'windowsPty'> {
  return style === 'win32' ? { windowsPty: { backend: 'conpty' } } : {};
}
