import { homedir, hostname, userInfo } from 'node:os';
import { Hono } from 'hono';
import type { HostInfo } from '@puddle/shared';
import { readConfig } from '../../config.js';
import { canonicalHostPath } from '../../host-path.js';
import type { PuddlePaths } from '../../paths.js';

/** Who and where the daemon is — the UI's host indicator (SPEC §6). */
export function hostRoutes(deps: { paths: PuddlePaths }): Hono {
  return new Hono().get('/', (c) => {
    const { displayName } = readConfig(deps.paths);
    return c.json<HostInfo>({
      username: userInfo().username,
      // .local is mDNS noise on macOS, not identity.
      hostname: hostname().replace(/\.local$/, ''),
      // Canonical on Windows (decision 11), so the UI's tildify and path
      // comparisons see the same spelling as every other emitted path.
      home: canonicalHostPath(homedir()),
      ...(displayName ? { displayName } : {}),
      platform: process.platform,
    });
  });
}
