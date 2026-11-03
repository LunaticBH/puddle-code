import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  puddlangStartSchema,
  puddlangContextSchema,
  puddlangRunSchema,
  puddlangEventsSchema,
} from '@puddle/shared';
import type { PuddlangService } from '../../../puddlang/service.js';
import { hexIdParam, parseBody } from '../../validate.js';
import { ApiError } from '../../errors.js';

/** Initially local/SSH only; remote profile middleware rejects this namespace. */
export function puddlangRoutes(service: PuddlangService): Hono {
  return new Hono()
    .use('*', bodyLimit({ maxSize: 1024 * 1024 }))
    .get('/:profile/context', (c) =>
      c.json(puddlangContextSchema.parse(service.context(hexIdParam(c, 'profile')))),
    )
    .post('/:profile/runs', async (c) => {
      const input = await parseBody(c, puddlangStartSchema);
      return c.json(puddlangRunSchema.parse(service.start(hexIdParam(c, 'profile'), input)), 202);
    })
    .get('/:profile/runs/:id', (c) =>
      c.json(
        puddlangRunSchema.parse(service.store.get(hexIdParam(c, 'profile'), c.req.param('id'))),
      ),
    )
    .get('/:profile/runs/:id/events', (c) => {
      const after = Number(c.req.query('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0)
        throw ApiError.badRequest('invalid_cursor', 'after must be a non-negative integer');
      return c.json(
        puddlangEventsSchema.parse(
          service.store.events(hexIdParam(c, 'profile'), c.req.param('id'), after),
        ),
      );
    })
    .post('/:profile/runs/:id/cancel', async (c) =>
      c.json(
        puddlangRunSchema.parse(await service.cancel(hexIdParam(c, 'profile'), c.req.param('id'))),
      ),
    );
}
