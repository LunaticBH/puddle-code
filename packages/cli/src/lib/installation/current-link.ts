import { readlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The daemon version a `bin/current` link names. install.sh writes the
 * relative symlink `versions/<X.Y.Z>`; the Windows installer writes a
 * directory junction, whose target reads back as an absolute backslashed
 * path that may end in a separator (`C:\…\bin\versions\0.3.14\`). Only the
 * Windows form is normalised, so POSIX targets match exactly as before.
 */
export function versionFromLinkTarget(
  target: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const normalised = platform === 'win32' ? target.replace(/\\/g, '/').replace(/\/+$/, '') : target;
  return /(?:^|\/)versions\/([^/\s]+)$/.exec(normalised)?.[1];
}

/** The version `<home>/bin/current` points at, read without executing anything. */
export function readCurrentVersion(
  home: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  try {
    return versionFromLinkTarget(readlinkSync(join(home, 'bin', 'current')), platform);
  } catch {
    return undefined;
  }
}
