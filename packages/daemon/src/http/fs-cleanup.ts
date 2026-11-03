import { rmSync } from 'node:fs';
import { sep } from 'node:path';
import { toRootRelative } from '@puddle/shared';
import { hostPathApi } from '../host-path.js';

/**
 * Removes a directory only if it sits inside the given root — a guard so a
 * corrupted config_dir row can never aim rm -rf outside ~/.puddle/profiles.
 *
 * Windows compares case-insensitively across separators (a home spelt
 * differently from when the row was stored is still the same home), retries
 * while a just-killed ConPTY child releases its handles, and warns instead of
 * failing the request once the row it cleans up after is already gone.
 */
export function removeDirWithin(
  root: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const { resolve } = hostPathApi(platform);
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const inside =
    platform === 'win32'
      ? Boolean(toRootRelative(resolvedRoot, resolvedTarget)) // strictly below, never the root
      : resolvedTarget.startsWith(resolvedRoot + sep);
  if (!inside) {
    console.warn(`refusing to remove ${resolvedTarget}: outside ${resolvedRoot}`);
    return;
  }
  if (platform !== 'win32') {
    rmSync(resolvedTarget, { recursive: true, force: true });
    return;
  }
  try {
    rmSync(resolvedTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.warn(`could not remove ${resolvedTarget}: ${(error as Error).message}`);
  }
}
