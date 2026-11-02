import { describe, expect, it } from 'vitest';
import {
  agentModeSchema,
  agentSignalRequestSchema,
  createSessionRequestSchema,
  compilationCapabilitiesResponseSchema,
  compilationFailureSchema,
  compilationModeRequestSchema,
  compilationRunResponseSchema,
  compilationSettingsResponseSchema,
  updateCompilationSettingsRequestSchema,
  diffResponseSchema,
  diffStatusSchema,
  editorTabRefSchema,
  errorResponseSchema,
  fileResponseSchema,
  logResponseSchema,
  latexSynctexRequestSchema,
  latexSynctexResponseSchema,
  profileSettingsSchema,
  PROTOCOL_VERSION,
  puddlangSpawnSchema,
  sessionEnvResponseSchema,
  sessionSchema,
  sessionStatusSchema,
  showCommitResponseSchema,
  treeResponseSchema,
  transferEntryRequestSchema,
  uiStateSnapshotSchema,
  uploadResponseSchema,
  wsClientMessageSchema,
} from '../src/index.js';

describe('shared API schemas', () => {
  it('declares protocol 25.0 for terminal-only programme execution', () => {
    expect(PROTOCOL_VERSION).toEqual({ major: 25, minor: 5 });
  });

  it('accepts headless mode and rejects the previous scripted name', () => {
    const target = { agent: 'codex', project: 'app' };
    expect(puddlangSpawnSchema.parse({ ...target, mode: 'headless' }).mode).toBe('headless');
    expect(puddlangSpawnSchema.parse(target).mode).toBeUndefined();
    expect(agentModeSchema.parse('interactive')).toBe('interactive');
    expect(agentModeSchema.parse('headless')).toBe('headless');
    expect(agentModeSchema.safeParse('scripted').success).toBe(false);
    expect(puddlangSpawnSchema.safeParse({ ...target, mode: 'scripted' }).success).toBe(false);
  });

  it('accepts a well-formed error envelope and rejects a malformed one', () => {
    const parsed = errorResponseSchema.parse({
      error: { code: 'not_found', message: 'no such profile' },
    });
    expect(parsed.error.code).toBe('not_found');
    expect(errorResponseSchema.safeParse({ error: { message: 'x' } }).success).toBe(false);
  });

  it('profile settings default the permissions gate to off and keep unknown keys', () => {
    const s = profileSettingsSchema.parse({ theme: 'dark' });
    expect(s.allowSkipPermissions).toBe(false);
    expect((s as Record<string, unknown>).theme).toBe('dark');
  });

  it('session status is a closed enum', () => {
    expect(sessionStatusSchema.safeParse('running').success).toBe(true);
    expect(sessionStatusSchema.safeParse('paused').success).toBe(false);
  });

  it('create-session accepts optional prompt and skip flag', () => {
    const r = createSessionRequestSchema.parse({
      project_id: 'a1b2c3d4e5',
      account_id: 2,
      prompt: 'go',
    });
    expect(r.skip_permissions).toBeUndefined();
  });

  it('worktree tree/file/upload shapes accept well-formed responses', () => {
    const tree = treeResponseSchema.parse({
      path: 'src',
      entries: [
        { name: 'index.ts', type: 'file', size: 128 },
        { name: 'lib', type: 'dir', size: null },
      ],
    });
    expect(tree.entries[1].size).toBeNull();

    const file = fileResponseSchema.parse({
      path: 'src/index.ts',
      content: 'export {}',
      binary: false,
      size: 9,
      mtime_ms: 1000,
    });
    expect(file.binary).toBe(false);

    const upload = uploadResponseSchema.parse({ files: [{ path: 'a.png', size: 42 }] });
    expect(upload.files).toHaveLength(1);
  });

  it('diffStatus is a closed enum and diffResponse resolves base_ref nullably', () => {
    expect(diffStatusSchema.safeParse('renamed').success).toBe(true);
    expect(diffStatusSchema.safeParse('untracked').success).toBe(false);

    const diff = diffResponseSchema.parse({
      against: 'deadbeef',
      base_ref: null,
      entries: [{ path: 'a.ts', status: 'modified', old_path: null }],
    });
    expect(diff.base_ref).toBeNull();
  });

  it('log and show-commit responses carry commit summaries', () => {
    const log = logResponseSchema.parse({
      commits: [
        {
          sha: 'abc123',
          subject: 'fix: thing',
          author_name: 'A',
          author_email: 'a@example.com',
          authored_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      has_more: false,
    });
    expect(log.has_more).toBe(false);

    const show = showCommitResponseSchema.parse({
      commit: {
        sha: 'abc123',
        subject: 'fix: thing',
        author_name: 'A',
        author_email: 'a@example.com',
        authored_at: '2026-01-01T00:00:00.000Z',
        body: 'longer description',
      },
      parents: ['def456'],
      files: [{ path: 'a.ts', status: 'added', old_path: null }],
    });
    expect(show.commit.body).toBe('longer description');
  });

  it('session git_summary is optional and nullable', () => {
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      project_id: 'a1b2c3d4e5',
      account_id: 1,
      worktree_path: '/tmp/wt',
      base_branch: 'main',
      branch: 'main',
      separate_branch: true,
      kind: 'agent' as const,
      agent_type: 'claude-code',
      agent_session_ref: null,
      title: null,
      status: 'running' as const,
      skip_permissions: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      last_activity_at: null,
    };
    expect(sessionSchema.parse(base).git_summary).toBeUndefined();
    const withSummary = sessionSchema.parse({
      ...base,
      git_summary: { ahead: 1, behind: 0, dirty_files: 3 },
    });
    expect(withSummary.git_summary).toEqual({ ahead: 1, behind: 0, dirty_files: 3 });
    expect(sessionSchema.parse({ ...base, git_summary: null }).git_summary).toBeNull();
  });

  it('ui-state defaults active_editor_tab to null and explorer_open to true', () => {
    const state = uiStateSnapshotSchema.parse({});
    expect(state.active_editor_tab).toBeNull();
    expect(state.explorer_open).toBe(true);

    const withTab = uiStateSnapshotSchema.parse({
      active_editor_tab: { session: '11111111-1111-4111-8111-111111111111', path: 'a.ts' },
      explorer_open: false,
    });
    expect(withTab.explorer_open).toBe(false);
  });

  it('accepts and round-trips locked editor refs', () => {
    const tab = {
      session: '11111111-1111-4111-8111-111111111111',
      path: 'README.md',
      view: 'locked' as const,
    };
    expect(editorTabRefSchema.parse(tab)).toEqual(tab);
  });

  it('accepts optional captured env values introduced at protocol 16.2', () => {
    expect(
      sessionEnvResponseSchema.parse({
        vars: [
          { name: 'NEW_DAEMON', bytes: 5, value: 'hello' },
          { name: 'OLD_DAEMON', bytes: 5 },
        ],
      }),
    ).toEqual({
      vars: [
        { name: 'NEW_DAEMON', bytes: 5, value: 'hello' },
        { name: 'OLD_DAEMON', bytes: 5 },
      ],
    });
  });

  it('validates cross-filetree transfers', () => {
    expect(
      transferEntryRequestSchema.parse({
        operation: 'copy',
        source: {
          session_id: '11111111-1111-4111-8111-111111111111',
          root: '/source',
        },
        from: 'docs/readme.md',
        to: 'imported/readme.md',
      }),
    ).toEqual({
      operation: 'copy',
      source: {
        session_id: '11111111-1111-4111-8111-111111111111',
        root: '/source',
      },
      from: 'docs/readme.md',
      to: 'imported/readme.md',
    });
  });

  it('accepts additive native conversation fields and lifecycle signals', () => {
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      project_id: 'a1b2c3d4e5',
      account_id: 2,
      worktree_path: '/repo',
      base_branch: 'main',
      branch: 'topic',
      separate_branch: true,
      kind: 'agent',
      agent_type: 'codex',
      agent_session_ref: 'thread-1',
      title: null,
      status: 'running',
      skip_permissions: false,
      created_at: '2026-08-22T00:00:00.000Z',
      updated_at: '2026-08-22T00:00:00.000Z',
      last_activity_at: null,
    };
    expect(
      sessionSchema.parse({
        ...base,
        conversation_id: 3,
        parent_conversation_id: 2,
        conversation_missing: true,
        branch_owner: false,
        native_sync: 'fallback',
      }),
    ).toMatchObject({ conversation_id: 3, parent_conversation_id: 2, native_sync: 'fallback' });
    expect(
      agentSignalRequestSchema.parse({
        nonce: '1234567890abcdef',
        event: 'session_start',
        agent_session_ref: 'thread-2',
        cwd: '/repo',
        source: 'fork',
        parent_agent_session_ref: 'thread-1',
      }),
    ).toMatchObject({ event: 'session_start', source: 'fork' });
  });

  it('validates generic compilation and LaTeX navigation contracts', () => {
    const source = {
      session: '11111111-1111-4111-8111-111111111111',
      path: 'docs/paper.tex',
    };
    expect(
      compilationCapabilitiesResponseSchema.parse({
        providers: [
          {
            id: 'latex',
            display_name: 'LaTeX',
            extensions: ['tex'],
            input_extensions: ['tex', 'bib', 'sty', 'cls', 'bst'],
            available: true,
            executor: 'latexmk',
            eager: true,
          },
        ],
      }).providers[0]?.input_extensions,
    ).toContain('bib');
    expect(compilationModeRequestSchema.parse({ source, mode: 'eager' }).mode).toBe('eager');
    expect(
      updateCompilationSettingsRequestSchema.parse({
        source,
        profile_id: 'aaaaaaaaaa',
        project_id: '1111111111',
        mode: 'eager',
        command: 'latexmk -outdir={{output_dir}} {{source}}',
      }).command,
    ).toContain('latexmk');
    expect(
      compilationSettingsResponseSchema.parse({
        provider: 'latex',
        display_name: 'LaTeX',
        file_type: 'tex',
        file_path: '/repo/docs/paper.tex',
        variables: [{ placeholder: '{{source}}', description: 'Source document' }],
        commands: [
          {
            mode: 'on_demand',
            run_when: 'when_clicked',
            default_command: 'latexmk {{source}}',
            override_command: null,
          },
        ],
      }).commands[0]?.run_when,
    ).toBe('when_clicked');
    expect(
      compilationFailureSchema.parse({
        message: 'build failed',
        output: 'paper.tex:9: Undefined control sequence.',
        diagnostics: [
          {
            source,
            severity: 'error',
            message: 'Undefined control sequence.',
            line: 9,
          },
        ],
      }).diagnostics?.[0]?.line,
    ).toBe(9);
    expect(
      compilationRunResponseSchema.parse({
        provider: 'latex',
        executor: 'latexmk',
        revision: 2,
        source,
        artifacts: [
          {
            role: 'preview',
            media_type: 'application/pdf',
            file: { ...source, path: 'paper.pdf', root: '/state/latex/current' },
          },
        ],
        navigation: { kind: 'synctex' },
      }).artifacts[0]?.role,
    ).toBe('preview');
    const inverse = latexSynctexRequestSchema.parse({
      ...source,
      path: 'paper.pdf',
      root: '/state/latex/current',
      page: 1,
      x: 72,
      y: 144,
    });
    expect(inverse.page).toBe(1);
    expect(latexSynctexResponseSchema.parse({ ...source, line: 12, column: 3 }).line).toBe(12);
  });

  it('ws client messages discriminate on t and validate term ids', () => {
    expect(
      wsClientMessageSchema.parse({ t: 'attach', session: 'x', term: 'agent', cols: 80, rows: 24 })
        .t,
    ).toBe('attach');
    expect(wsClientMessageSchema.safeParse({ t: 'attach', term: 'agent' }).success).toBe(false);
    expect(
      wsClientMessageSchema.safeParse({ t: 'stdin', session: 'x', term: 'nope', data: 'y' })
        .success,
    ).toBe(false);
  });
});
