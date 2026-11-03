import type { IncomingMessage, ServerResponse } from 'node:http';
import { cockpitRemoteRequestSchema, connectorProfileSchema } from '@puddle/shared';
import type { RemoteAccessControl } from '../host/remote-access.js';
import { fail, json, readJson } from './http-auth.js';

/** Called only after exact cockpit Host/Origin and browser authentication. */
export function remoteAccessHandler(control: RemoteAccessControl | undefined) {
  let busy = false;
  return async (req: IncomingMessage, res: ServerResponse, authorised: () => boolean) => {
    if (!control) return fail(res, 404, 'remote_controls_unavailable');
    if (req.method !== 'GET' && req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
    const url = new URL(req.url!, 'http://localhost');
    const scope = connectorProfileSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!scope.success || url.searchParams.getAll('profile').length !== 1)
      return fail(res, 400, 'invalid_profile', 'Select the profile to manage remote access.');
    const { profile } = scope.data;
    const request =
      req.method === 'POST' ? cockpitRemoteRequestSchema.parse(await readJson(req)) : null;
    if (!authorised()) return fail(res, 401, 'browser_rejected');
    if (busy)
      return fail(res, 409, 'remote_control_busy', 'A host operation is already in progress.');
    busy = true;
    try {
      const response = request
        ? await control.request(request, authorised, profile)
        : await control.status(profile);
      if (!authorised()) return fail(res, 401, 'browser_rejected');
      json(res, 200, response);
    } catch (error) {
      fail(
        res,
        503,
        'remote_control_unavailable',
        error instanceof Error ? error.message : 'Host control is unavailable.',
      );
    } finally {
      busy = false;
    }
  };
}
