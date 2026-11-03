import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  savedLayoutSchema,
  type CreateLayoutRequest,
  type LayoutNode,
  type SavedLayout,
} from '@puddle/shared';
import { ApiError } from '../../src/http/errors.js';
import { layoutRoutes } from '../../src/http/routes/layouts.js';
import { fixture, type Fixture } from '../helpers/daemon-fixtures.js';

let fx: Fixture;
let app: Hono;
let profile: string;
let project: string;
let otherProject: string;

const SESSION = '3b241101-e2bb-4255-8caf-4136c566a962';
const tree = (session: string): LayoutNode => ({
  kind: 'leaf',
  id: 'leaf-1',
  tabs: [{ type: 'terminal', session }],
  activeKey: `term:${session}`,
  previewKey: null,
});

beforeAll(() => {
  fx = fixture();
  profile = fx.ids.profile;
  project = fx.ids.project;
  otherProject = fx.stores.projects.create({
    profile_id: profile,
    repo_id: fx.ids.repo,
    name: 'other',
  }).id;

  app = new Hono();
  app.onError((err, c) =>
    err instanceof ApiError
      ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
      : c.json({ error: { code: 'internal', message: String(err) } }, 500),
  );
  app.route('/api/layouts', layoutRoutes(fx.stores));
});

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

const post = (body: CreateLayoutRequest) =>
  app.request('/api/layouts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const list = (proj?: string) =>
  app.request(`/api/layouts?profile=${profile}${proj ? `&project=${proj}` : ''}`);
const patch = (id: number, body: unknown) =>
  app.request(`/api/layouts/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('layouts CRUD + scope', () => {
  it('creates project- and profile-scoped layouts and round-trips the tree', async () => {
    const p = await post({
      profile_id: profile,
      scope: 'project',
      project_id: project,
      name: 'terminal wall',
      layout_tree: tree(SESSION),
      active_session: SESSION,
    });
    expect(p.status).toBe(201);
    expect(savedLayoutSchema.parse(await p.json())).toMatchObject({
      scope: 'project',
      project_id: project,
      name: 'terminal wall',
      layout_tree: tree(SESSION),
      active_session: SESSION,
    });

    const g = await post({
      profile_id: profile,
      scope: 'profile',
      name: 'clean slate',
      layout_tree: null,
    });
    expect(g.status).toBe(201);
    expect(savedLayoutSchema.parse(await g.json())).toMatchObject({
      scope: 'profile',
      project_id: null,
      layout_tree: null,
      active_session: null,
    });
  });

  it('rejects a project-scoped layout without a project_id', async () => {
    const res = await post({
      profile_id: profile,
      scope: 'project',
      name: 'orphan',
      layout_tree: null,
    });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_scope');
  });

  it('scopes the list per project, and lists everything without one', async () => {
    const here = (await (await list(project)).json()) as SavedLayout[];
    expect(here.map((l) => l.name)).toContain('terminal wall');
    expect(here.map((l) => l.name)).toContain('clean slate');

    const there = (await (await list(otherProject)).json()) as SavedLayout[];
    expect(there.map((l) => l.name)).not.toContain('terminal wall'); // another project's
    expect(there.map((l) => l.name)).toContain('clean slate'); // profile-wide, still shown

    // No project (the dashboard): every layout of the profile, so none is
    // orphaned out of reach of rename/delete.
    const all = (await (await list()).json()) as SavedLayout[];
    expect(all.map((l) => l.name)).toContain('terminal wall');
    expect(all.map((l) => l.name)).toContain('clean slate');
  });

  it('renames and saves over via PATCH, and deletes', async () => {
    const created = savedLayoutSchema.parse(
      await (
        await post({ profile_id: profile, scope: 'profile', name: 'temp', layout_tree: null })
      ).json(),
    );
    const renamed = savedLayoutSchema.parse(
      await (await patch(created.id, { name: 'kept' })).json(),
    );
    expect(renamed.name).toBe('kept');
    expect(renamed.layout_tree).toBeNull();

    const savedOver = savedLayoutSchema.parse(
      await (
        await patch(created.id, { layout_tree: tree(SESSION), active_session: SESSION })
      ).json(),
    );
    expect(savedOver.name).toBe('kept');
    expect(savedOver.layout_tree).toEqual(tree(SESSION));
    expect(savedOver.active_session).toBe(SESSION);

    const del = await app.request(`/api/layouts/${created.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect((await patch(created.id, { name: 'x' })).status).toBe(404);
  });

  it('404s an unknown profile on create, and empty list without a profile', async () => {
    const res = await post({
      profile_id: 'ffffffffff',
      scope: 'profile',
      name: 'x',
      layout_tree: null,
    });
    expect(res.status).toBe(404);
    expect(await (await app.request('/api/layouts')).json()).toEqual([]);
  });
});
