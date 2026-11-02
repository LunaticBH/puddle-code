import { Hono } from 'hono';
import { daemonConfigPatchSchema } from '@puddle/shared';
import { readConfig, saveConfig } from '../../config.js';
import type { PuddlePaths } from '../../paths.js';
import { parseBody } from '../validate.js';

/** Daemon-scope settings; port changes apply on daemon restart (SPEC §6). */
export function configRoutes(deps: { paths: PuddlePaths }): Hono {
  return new Hono()
    .get('/', (c) => c.json(readConfig(deps.paths)))
    .patch('/', async (c) => {
      const patch = await parseBody(c, daemonConfigPatchSchema);
      return c.json(saveConfig(deps.paths, patch));
    });
}
