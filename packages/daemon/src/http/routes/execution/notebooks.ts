import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  notebookExecuteSchema,
  notebookInputReplySchema,
  notebookIntelligenceRequestSchema,
  notebookWidgetsRequestSchema,
  notebookWidgetCommSchema,
} from '@puddle/shared';
import { notebookKernelActionSchema, notebookKernelRequestSchema } from '@puddle/shared';
import type { NotebookKernels } from '../../../notebooks/kernels.js';
import { parseBody } from '../../validate.js';

export function notebookRoutes(
  kernels: Pick<
    NotebookKernels,
    | 'catalogue'
    | 'status'
    | 'action'
    | 'environments'
    | 'executeCells'
    | 'executionStatus'
    | 'replyToInput'
    | 'intelligence'
    | 'widgetState'
    | 'widgetComm'
  >,
): Hono {
  return new Hono()
    .use('*', bodyLimit({ maxSize: 2 * 1024 * 1024 }))
    .post('/widgets', async (c) =>
      c.json(await kernels.widgetState(await parseBody(c, notebookWidgetsRequestSchema))),
    )
    .post('/widgets/comm', async (c) => {
      await kernels.widgetComm(await parseBody(c, notebookWidgetCommSchema));
      return c.body(null, 204);
    })
    .post('/intelligence', async (c) =>
      c.json(await kernels.intelligence(await parseBody(c, notebookIntelligenceRequestSchema))),
    )
    .post('/execute', async (c) =>
      c.json(await kernels.executeCells(await parseBody(c, notebookExecuteSchema))),
    )
    .post('/execution', async (c) =>
      c.json(
        await kernels.executionStatus((await parseBody(c, notebookKernelRequestSchema)).source),
      ),
    )
    .post('/input', async (c) => {
      await kernels.replyToInput(await parseBody(c, notebookInputReplySchema));
      return c.body(null, 204);
    })
    .get('/kernels', async (c) => c.json(await kernels.catalogue()))
    .post('/environments', async (c) => {
      const request = await parseBody(c, notebookKernelRequestSchema);
      return c.json(await kernels.environments(request.source));
    })
    .post('/status', async (c) => {
      const request = await parseBody(c, notebookKernelRequestSchema);
      return c.json(await kernels.status(request.source));
    })
    .post('/kernel', async (c) => {
      const request = await parseBody(c, notebookKernelActionSchema);
      return c.json(await kernels.action(request));
    });
}
