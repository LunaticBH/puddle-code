import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  compilationCapabilitiesResponseSchema,
  compilationDefaultsResponseSchema,
  compilationRunResponseSchema,
  compilationSettingsResponseSchema,
  compilationStatusResponseSchema,
} from '@puddle/shared';
import { openDatabase } from '../../src/db/db.js';
import { CompilationSettingsStore } from '../../src/db/stores/compilation-settings.js';
import { ProfileStore } from '../../src/db/stores/profiles.js';
import { ProjectStore } from '../../src/db/stores/projects.js';
import { RepoStore } from '../../src/db/stores/repos.js';
import type { CompilationProvider } from '../../src/compilation/provider.js';
import { CompilationService } from '../../src/compilation/service.js';
import { ApiError } from '../../src/http/errors.js';
import { expandCommandTemplate } from '../../src/compilation/command-template.js';
import { compilationRoutes } from '../../src/http/routes/execution/compilation.js';

const source = {
  session: '00000000-0000-0000-0000-000000000000',
  path: 'paper.tex',
  root: '/source',
};

function fixture(eager = true) {
  const db = openDatabase(':memory:');
  const profiles = new ProfileStore(db);
  const projects = new ProjectStore(db);
  const repos = new RepoStore(db);
  const profile = profiles.create({ name: 'compile', branch_prefix: 'compile/' });
  const repo = repos.create({
    path: '/source',
    default_base_branch: 'main',
    onboarding_notes: null,
    fetch_enabled: false,
  });
  const project = projects.create({ profile_id: profile.id, repo_id: repo.id, name: 'paper' });
  const commands: Array<{ mode: string; command: string | null }> = [];
  const provider: CompilationProvider = {
    id: 'latex',
    displayName: 'LaTeX',
    extensions: ['tex'],
    inputExtensions: ['tex', 'bib', 'sty', 'cls', 'bst'],
    eager,
    capability: () => ({ available: true, executor: 'latexmk' }),
    languageConfiguration: () => ({
      fileType: 'tex',
      variables: [],
      defaults: {
        on_demand: 'latexmk -outdir={{output_dir}} {{source}}',
        eager: 'latexmk -outdir={{output_dir}} {{source}}',
      },
    }),
    commandConfiguration: (target) => ({
      filePath: `${target.root}/${target.path}`,
      fileType: 'tex',
      variables: [
        { placeholder: '{{source}}', description: 'Source' },
        { placeholder: '{{output_dir}}', description: 'Output' },
      ],
      defaults: {
        on_demand: 'latexmk -outdir={{output_dir}} {{source}}',
        eager: 'latexmk -outdir={{output_dir}} {{source}}',
      },
    }),
    validateCommand: (_source, command) => {
      expandCommandTemplate(command, { source: '/source/paper.tex', output_dir: '/output' });
    },
    watchInputs: () => [],
    run: async (target, options) => {
      commands.push(options);
      return {
        executor: 'latexmk',
        source: target,
        artifacts: [
          {
            role: 'preview',
            media_type: 'application/pdf',
            file: { session: target.session, path: 'paper.pdf', root: '/state/latex/build' },
          },
        ],
        navigation: { kind: 'synctex' },
        dependencies: [],
      };
    },
  };
  const compilation = new CompilationService([provider], {
    settings: new CompilationSettingsStore(db),
    projects,
    profiles,
  });
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof ApiError
      ? c.json({ error: { code: error.code, message: error.message } }, error.status as 400)
      : c.json({ error: { code: 'internal', message: String(error) } }, 500),
  );
  app.route('/api/compilation', compilationRoutes({ compilation }));
  return { app, compilation, commands, profile, project, profiles, db, provider };
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('compilation routes', () => {
  it('reports provider availability and performs an on-demand run', async () => {
    const { app, compilation } = fixture();
    const capabilities = compilationCapabilitiesResponseSchema.parse(
      await (await app.request('/api/compilation/capabilities')).json(),
    );
    expect(capabilities.providers).toEqual([
      {
        id: 'latex',
        display_name: 'LaTeX',
        extensions: ['tex'],
        input_extensions: ['tex', 'bib', 'sty', 'cls', 'bst'],
        available: true,
        executor: 'latexmk',
        eager: true,
      },
    ]);

    const response = await app.request('/api/compilation/run', jsonRequest('POST', { source }));
    expect(response.status).toBe(200);
    expect(compilationRunResponseSchema.parse(await response.json())).toMatchObject({
      provider: 'latex',
      executor: 'latexmk',
      revision: 1,
      navigation: { kind: 'synctex' },
      artifacts: [{ role: 'preview', media_type: 'application/pdf' }],
    });
    compilation.dispose();
  });

  it('registers eager mode, exposes pollable status, and retires the watcher', async () => {
    const { app, compilation } = fixture();
    const eager = await app.request(
      '/api/compilation/mode',
      jsonRequest('PUT', { source, mode: 'eager' }),
    );
    expect(compilationStatusResponseSchema.parse(await eager.json())).toMatchObject({
      provider: 'latex',
      mode: 'eager',
      state: 'succeeded',
      revision: 1,
    });
    const status = await app.request('/api/compilation/status', jsonRequest('POST', { source }));
    expect(compilationStatusResponseSchema.parse(await status.json()).mode).toBe('eager');
    const retired = await app.request(
      '/api/compilation/mode',
      jsonRequest('PUT', { source, mode: 'on_demand' }),
    );
    expect(compilationStatusResponseSchema.parse(await retired.json()).mode).toBe('on_demand');
    compilation.dispose();
  });

  it('validates requests at the route boundary', async () => {
    const { app, compilation } = fixture();
    const response = await app.request(
      '/api/compilation/run',
      jsonRequest('POST', { source: { session: 'not-a-session', path: '' } }),
    );
    expect(response.status).toBe(400);
    compilation.dispose();
  });

  it('persists separate rooted-file commands for clicked and file-change runs', async () => {
    const { app, compilation, commands, profile, project } = fixture();
    const scope = { profile_id: profile.id, project_id: project.id };
    const initial = await app.request(
      '/api/compilation/settings',
      jsonRequest('POST', { source, ...scope }),
    );
    expect(compilationSettingsResponseSchema.parse(await initial.json())).toMatchObject({
      file_path: '/source/paper.tex',
      commands: [
        { mode: 'on_demand', run_when: 'when_clicked', override_command: null },
        { mode: 'eager', run_when: 'upon_file_change', override_command: null },
      ],
    });

    await app.request(
      '/api/compilation/settings',
      jsonRequest('PUT', {
        source,
        ...scope,
        mode: 'on_demand',
        command: 'manual {{source}} --out {{output_dir}}',
      }),
    );
    await app.request('/api/compilation/run', jsonRequest('POST', { source, ...scope }));
    expect(commands.at(-1)).toEqual({
      mode: 'on_demand',
      command: 'manual {{source}} --out {{output_dir}}',
    });

    await app.request(
      '/api/compilation/settings',
      jsonRequest('PUT', {
        source,
        ...scope,
        mode: 'eager',
        command: 'eager {{source}} --out {{output_dir}}',
      }),
    );
    await app.request(
      '/api/compilation/mode',
      jsonRequest('PUT', { source, ...scope, mode: 'eager' }),
    );
    expect(commands.at(-1)).toEqual({
      mode: 'eager',
      command: 'eager {{source}} --out {{output_dir}}',
    });
    compilation.dispose();
  });

  it('inherits profile defaults, preserves file overrides, and resets each layer independently', async () => {
    const { app, compilation, commands, profile, project, profiles, db } = fixture();
    const defaults = { profile_id: profile.id, provider: 'latex' };
    const scope = { profile_id: profile.id, project_id: project.id };
    const putDefault = (command: string | null, mode = 'on_demand') =>
      app.request('/api/compilation/defaults', jsonRequest('PUT', { ...defaults, mode, command }));
    const run = async (path = source.path) => {
      await app.request(
        '/api/compilation/run',
        jsonRequest('POST', { source: { ...source, path }, ...scope }),
      );
      return commands.at(-1)?.command;
    };
    const initial = await app.request('/api/compilation/defaults', jsonRequest('POST', defaults));
    expect(initial.status).toBe(200);
    expect(compilationDefaultsResponseSchema.parse(await initial.json()).commands).toHaveLength(2);
    expect((await putDefault('profile-tex {{source}}')).status).toBe(200);
    expect(await run()).toBe('profile-tex {{source}}');
    expect(await run('other.tex')).toBe('profile-tex {{source}}');
    const inherited = await app.request(
      '/api/compilation/settings',
      jsonRequest('POST', { source, ...scope }),
    );
    expect(
      compilationSettingsResponseSchema.parse(await inherited.json()).commands[0],
    ).toMatchObject({
      inherited_command: 'profile-tex {{source}}',
      default_command: 'latexmk -outdir={{output_dir}} {{source}}',
      override_command: null,
    });
    // Existing per-file commands take precedence without being rewritten.
    const fileOverride = { source, ...scope, mode: 'on_demand', command: 'file-tex {{source}}' };
    await app.request('/api/compilation/settings', jsonRequest('PUT', fileOverride));
    await putDefault('new-profile-tex {{source}}');
    expect(await run()).toBe('file-tex {{source}}');
    expect(await run('other.tex')).toBe('new-profile-tex {{source}}');
    // SQLite is the source of truth, rather than service-local state.
    expect(new CompilationSettingsStore(db).getDefault(profile.id, 'latex', 'on_demand')).toBe(
      'new-profile-tex {{source}}',
    );
    const other = profiles.create({ name: 'other', branch_prefix: '' });
    expect(
      compilation.defaults({ ...defaults, profile_id: other.id }).commands[0]?.override_command,
    ).toBeNull();
    expect(compilation.defaults(defaults).commands[1]?.override_command).toBeNull();
    await putDefault('eager-profile {{source}}', 'eager');
    await app.request(
      '/api/compilation/mode',
      jsonRequest('PUT', { source, ...scope, mode: 'eager' }),
    );
    expect(commands.at(-1)?.command).toBe('eager-profile {{source}}');
    await putDefault(null);
    expect(await run()).toBe('file-tex {{source}}');
    await app.request(
      '/api/compilation/settings',
      jsonRequest('PUT', { ...fileOverride, command: null }),
    );
    expect(await run()).toBeNull(); // Keeps provider-owned source/engine orchestration.
    compilation.dispose();
  });

  it('validates defaults without requiring a source file and rejects unsupported eager commands', async () => {
    const { app, compilation, profile } = fixture(false);
    const request = {
      profile_id: profile.id,
      provider: 'latex',
      mode: 'on_demand',
      command: 'custom {{source}}',
    };
    for (const [patch, status] of [
      [{ profile_id: '0000000000' }, 404],
      [{ provider: 'missing' }, 400],
      [{ mode: 'eager' }, 400],
      [{ command: '' }, 400],
      [{ command: 'custom {{unknown}}' }, 400],
      [{ command: 'custom {{source}} && touch /tmp/should-not-run' }, 400],
    ] as const) {
      const response = await app.request(
        '/api/compilation/defaults',
        jsonRequest('PUT', { ...request, ...patch }),
      );
      expect(response.status).toBe(status);
    }
    const response = await app.request('/api/compilation/defaults', jsonRequest('PUT', request));
    expect(response.status).toBe(200);
    expect(compilationDefaultsResponseSchema.parse(await response.json()).commands).toEqual([
      expect.objectContaining({ mode: 'on_demand', override_command: request.command }),
    ]);
    compilation.dispose();
  });
});
