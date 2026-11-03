import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  scratchpadEntrySchema,
  type CreateScratchpadRequest,
  type ScratchpadEntry,
} from '@puddle/shared';
import { ApiError } from '../../src/http/errors.js';
import { scratchpadRoutes } from '../../src/http/routes/scratchpad.js';
import { fixture, type Fixture } from '../helpers/daemon-fixtures.js';

let fx: Fixture;
let app: Hono;
let profile: string;
let project: string;
let otherProject: string;

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
  app.route('/api/scratchpad', scratchpadRoutes(fx.stores));
});

afterAll(() => undefined);

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

const post = (body: CreateScratchpadRequest) =>
  app.request('/api/scratchpad', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const list = (proj?: string) =>
  app.request(`/api/scratchpad?profile=${profile}${proj ? `&project=${proj}` : ''}`);
const patch = (id: number, body: unknown) =>
  app.request(`/api/scratchpad/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('scratchpad CRUD + scope', () => {
  it('creates project- and profile-scoped entries', async () => {
    const p = await post({
      profile_id: profile,
      scope: 'project',
      project_id: project,
      body: 'proj note',
    });
    expect(p.status).toBe(201);
    expect(scratchpadEntrySchema.parse(await p.json())).toMatchObject({
      scope: 'project',
      project_id: project,
      body: 'proj note',
    });

    const g = await post({
      profile_id: profile,
      scope: 'profile',
      body: 'global note',
      tags: ['x'],
    });
    expect(g.status).toBe(201);
    expect(scratchpadEntrySchema.parse(await g.json())).toMatchObject({
      scope: 'profile',
      project_id: null,
      tags: ['x'],
    });
  });

  it('rejects a project-scoped entry without a project_id', async () => {
    const res = await post({ profile_id: profile, scope: 'project', body: 'orphan' });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_scope');
  });

  it('scopes the list: profile entries everywhere, project entries only in their project', async () => {
    const here = (await (await list(project)).json()) as ScratchpadEntry[];
    const bodies = here.map((e) => e.body);
    expect(bodies).toContain('proj note');
    expect(bodies).toContain('global note');

    const there = (await (await list(otherProject)).json()) as ScratchpadEntry[];
    const otherBodies = there.map((e) => e.body);
    expect(otherBodies).not.toContain('proj note'); // hidden in another project
    expect(otherBodies).toContain('global note'); // profile-wide, still shown

    const profileOnly = (await (await list()).json()) as ScratchpadEntry[];
    expect(profileOnly.every((e) => e.scope === 'profile')).toBe(true);
  });

  it('places a fresh entry on top (smallest position)', async () => {
    const before = (await (await list(project)).json()) as ScratchpadEntry[];
    await post({ profile_id: profile, scope: 'project', project_id: project, body: 'newest' });
    const after = (await (await list(project)).json()) as ScratchpadEntry[];
    expect(after[0]!.body).toBe('newest');
    expect(after[0]!.position).toBeLessThan(before[0]!.position);
  });

  it('reorders via a PATCHed position', async () => {
    const rows = (await (await list(project)).json()) as ScratchpadEntry[];
    const last = rows[rows.length - 1]!;
    // Move the last entry above the current top.
    const res = await patch(last.id, { position: rows[0]!.position - 5 });
    expect(res.status).toBe(200);
    const after = (await (await list(project)).json()) as ScratchpadEntry[];
    expect(after[0]!.id).toBe(last.id);
  });

  it('flips scope, re-pairing project_id', async () => {
    const created = scratchpadEntrySchema.parse(
      await (
        await post({ profile_id: profile, scope: 'project', project_id: project, body: 'flip me' })
      ).json(),
    );
    const toProfile = scratchpadEntrySchema.parse(
      await (await patch(created.id, { scope: 'profile', project_id: null })).json(),
    );
    expect(toProfile).toMatchObject({ scope: 'profile', project_id: null });
    // Now visible in another project too.
    const there = (await (await list(otherProject)).json()) as ScratchpadEntry[];
    expect(there.map((e) => e.id)).toContain(created.id);
  });

  it('updates body/title/tags and deletes', async () => {
    const created = scratchpadEntrySchema.parse(
      await (await post({ profile_id: profile, scope: 'profile', body: 'temp' })).json(),
    );
    const patched = scratchpadEntrySchema.parse(
      await (await patch(created.id, { title: 'T', body: 'edited', tags: ['a', 'b'] })).json(),
    );
    expect(patched).toMatchObject({ title: 'T', body: 'edited', tags: ['a', 'b'] });

    const del = await app.request(`/api/scratchpad/${created.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect((await patch(created.id, { body: 'x' })).status).toBe(404);
  });

  it('404s an unknown profile on create, and empty list without a profile', async () => {
    const res = await post({ profile_id: 'ffffffffff', scope: 'profile', body: 'x' });
    expect(res.status).toBe(404);
    expect(await (await app.request('/api/scratchpad')).json()).toEqual([]);
  });
});
