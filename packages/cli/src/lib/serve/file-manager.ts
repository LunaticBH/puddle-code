import type { IncomingMessage, ServerResponse } from 'node:http';
import { cockpitRevealRequestSchema } from '@puddle/shared';
import type { LocalFileManager } from '../host/file-manager.js';
import { fail, json, readJson } from './http-auth.js';

/** Runs behind the cockpit's exact Host/Origin and browser authentication. */
export function fileManagerHandler(manager: LocalFileManager | undefined) {
  let busy = false;
  return async (req: IncomingMessage, res: ServerResponse, authorised: () => boolean) => {
    if (req.method === 'GET') return json(res, 200, { name: manager?.name ?? null });
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
    if (!manager) return fail(res, 404, 'file_manager_unavailable');
    const request = cockpitRevealRequestSchema.parse(await readJson(req));
    if (!authorised()) return fail(res, 401, 'browser_rejected');
    if (busy) return fail(res, 409, 'file_manager_busy', 'A folder is already being revealed.');
    busy = true;
    try {
      await manager.reveal(request.path, authorised);
      res.writeHead(204);
      res.end();
    } catch (error) {
      fail(
        res,
        400,
        'reveal_failed',
        error instanceof Error ? error.message : 'Could not reveal this path.',
      );
    } finally {
      busy = false;
    }
  };
}
