import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROFILE_ICON_COLOURS, projectSchema } from '@puddle/shared';
import { ApiError } from '../../src/http/errors.js';
import { projectRoutes } from '../../src/http/routes/projects.js';
import { ConversationCatalogue } from '../../src/sessions/conversation-catalogue.js';
import { fixture, type Fixture } from '../helpers/daemon-fixtures.js';

let fx: Fixture;
let app: Hono;
let catalogue: ConversationCatalogue;

beforeAll(() => {
  fx = fixture();
  catalogue = new ConversationCatalogue({
    ...fx.stores,
    adapters: fx.adapters,
    worktrees: fx.worktrees,
  });
  app = new Hono();
  app.onError((err, c) =>
    err instanceof ApiError
      ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
      : c.json({ error: { code: 'internal', message: String(err) } }, 500),
  );
  app.route('/api/projects', projectRoutes({ ...fx.stores, ...fx, catalogue }));
});

afterAll(() => {
  catalogue.dispose();
});

function request(method: string, path: string, body: unknown) {
  return app.request(`/api/projects${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('project colours', () => {
  it('stores every profile palette colour when creating a project', async () => {
    for (const colour of PROFILE_ICON_COLOURS) {
      const response = await request('POST', '', {
        profile_id: fx.ids.profile,
        repo_id: fx.ids.repo,
        name: `project-${colour}`,
        colour,
      });
      expect(response.status).toBe(201);
      const project = projectSchema.parse(await response.json());
      expect(project.colour).toBe(colour);
      expect(fx.stores.projects.get(project.id).colour).toBe(colour);
    }
  });

  it('preserves colour on unrelated edits and clears it only with null', async () => {
    const id = fx.ids.project;
    expect(fx.stores.projects.get(id).colour).toBeNull();
    const coloured = await request('PATCH', `/${id}`, { colour: 'violet' });
    expect(coloured.status).toBe(200);
    expect(projectSchema.parse(await coloured.json()).colour).toBe('violet');

    const renamed = await request('PATCH', `/${id}`, {
      name: 'renamed',
      abbrev: 'NEW',
      archived: true,
    });
    expect(projectSchema.parse(await renamed.json())).toMatchObject({
      name: 'renamed',
      abbrev: 'NEW',
      archived: true,
      colour: 'violet',
    });
    const listed = await app.request(`/api/projects?profile=${fx.ids.profile}`);
    expect(
      projectSchema
        .array()
        .parse(await listed.json())
        .find((p) => p.id === id)?.colour,
    ).toBe('violet');

    const cleared = await request('PATCH', `/${id}`, { colour: null });
    expect(projectSchema.parse(await cleared.json()).colour).toBeNull();
    expect(fx.stores.projects.get(id)).toMatchObject({ name: 'renamed', abbrev: 'NEW' });
  });

  it('rejects colours outside the palette without changing the saved value', async () => {
    await request('PATCH', `/${fx.ids.project}`, { colour: 'blue' });
    for (const colour of ['purple', '', 123]) {
      expect((await request('PATCH', `/${fx.ids.project}`, { colour })).status).toBe(400);
      expect(
        (
          await request('POST', '', {
            profile_id: fx.ids.profile,
            repo_id: fx.ids.repo,
            name: 'invalid',
            colour,
          })
        ).status,
      ).toBe(400);
    }
    expect(fx.stores.projects.get(fx.ids.project).colour).toBe('blue');
  });
});
