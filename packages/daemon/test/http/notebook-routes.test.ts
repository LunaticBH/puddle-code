import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { notebookRoutes } from '../../src/http/routes/execution/notebooks.js';
import { ApiError } from '../../src/http/errors.js';

it('validates notebook targets and lifecycle actions before dispatch', async () => {
  const source = {
    session: '00000000-0000-0000-0000-000000000000',
    root: '/source',
    path: 'analysis.ipynb',
  };
  const catalogue = vi.fn(async () => ({ available: true, kernels: [] }));
  const environments = vi.fn(async () => ({ environments: [] }));
  const status = vi.fn(async () => ({ state: 'stopped' as const, kernel: null }));
  const action = vi.fn(async () => ({ state: 'idle' as const, kernel: 'python3' }));
  const app = new Hono();
  app.onError((error, c) =>
    c.json({ error: String(error) }, error instanceof ApiError ? (error.status as 400) : 500),
  );
  app.route(
    '/api/notebooks',
    notebookRoutes({
      catalogue,
      status,
      action,
      environments,
      executeCells: vi.fn(),
      executionStatus: vi.fn(),
      replyToInput: vi.fn(),
      intelligence: vi.fn(),
      widgetState: vi.fn(),
      widgetComm: vi.fn(),
    }),
  );
  const post = (path: string, body: unknown) =>
    app.request(`/api/notebooks/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await app.request('/api/notebooks/kernels')).status).toBe(200);
  expect((await post('status', { source })).status).toBe(200);
  expect((await post('kernel', { source, action: 'select', kernel: 'python3' })).status).toBe(200);
  expect(action).toHaveBeenLastCalledWith({ source, action: 'select', kernel: 'python3' });
  for (const body of [
    { source, action: 'execute' },
    { source, action: 'select' },
    { action: 'interrupt' },
    { source: { ...source, session: 'invalid' }, action: 'shutdown' },
  ])
    expect((await post('kernel', body)).status).toBe(400);
  expect(action).toHaveBeenCalledTimes(1);
  expect((await post('environments', { source })).status).toBe(200);
  expect(environments).toHaveBeenCalledWith(source);
  expect((await post('environments', {})).status).toBe(400);
  expect((await post('kernel', { source, action: 'select-python', python: '.venv' })).status).toBe(
    200,
  );
  expect(action).toHaveBeenLastCalledWith({ source, action: 'select-python', python: '.venv' });
  expect(
    (await post('kernel', { source, action: 'install-python', python: '/env/bin/python' })).status,
  ).toBe(200);
  expect((await post('kernel', { source, action: 'install-python' })).status).toBe(400);
  for (const python of ['', '  ', 'x'.repeat(4097), 'python\0bad'])
    expect((await post('kernel', { source, action: 'select-python', python })).status).toBe(400);
});
