import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  diffResponseSchema,
  fileAtResponseSchema,
  gitOriginalResponseSchema,
  gitRepositoriesResponseSchema,
  indexFileResponseSchema,
  logResponseSchema,
  searchResponseSchema,
  showCommitResponseSchema,
} from '@puddle/shared';
import { sessionRoutes } from '../../src/http/routes/sessions.js';
import { worktreeRoutes } from '../../src/http/routes/worktrees/worktrees.js';
import { ApiError } from '../../src/http/errors.js';
import { cloneRepo, commitFile, sh } from '../helpers/git-fixtures.js';
import { fixture, waitFor, type Fixture } from '../helpers/daemon-fixtures.js';

let fx: Fixture;
let app: Hono;
const sessionIds: string[] = [];

beforeAll(() => {
  fx = fixture();

  app = new Hono();
  app.onError((err, c) =>
    err instanceof ApiError
      ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
      : c.json({ error: { code: 'internal', message: String(err) } }, 500),
  );
  app.route(
    '/api/worktrees',
    worktreeRoutes({ sessions: fx.stores.sessions, repos: fx.stores.repos }),
  );
  app.route('/api/sessions', sessionRoutes({ service: fx.service, scanner: fx.scanner }));
});

afterAll(async () => {
  for (const id of sessionIds) await fx.service.kill(id).catch(() => undefined);
});

async function newSession(title: string): Promise<{ sid: string; worktree: string }> {
  const session = await fx.service.create({
    project_id: fx.ids.project,
    account_id: fx.ids.account,
    title,
  });
  sessionIds.push(session.id);
  await waitFor(() => fx.service.get(session.id).status !== 'starting');
  return { sid: session.id, worktree: fx.service.get(session.id).worktree_path };
}

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

function diff(sid: string, against?: string) {
  const qs = against === undefined ? '' : `?against=${encodeURIComponent(against)}`;
  return app.request(`/api/worktrees/${sid}/diff${qs}`);
}

function fileAt(sid: string, ref: string, path: string) {
  return app.request(
    `/api/worktrees/${sid}/file-at?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
  );
}

function logReq(sid: string, params: { limit?: number | string; skip?: number | string } = {}) {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.skip !== undefined) qs.set('skip', String(params.skip));
  const s = qs.toString();
  return app.request(`/api/worktrees/${sid}/log${s ? `?${s}` : ''}`);
}

function show(sid: string, sha: string) {
  return app.request(`/api/worktrees/${sid}/show/${sha}`);
}

function search(
  sid: string,
  params: { q?: string; regex?: boolean; case?: boolean; word?: boolean } = {},
) {
  const qs = new URLSearchParams();
  if (params.q !== undefined) qs.set('q', params.q);
  if (params.regex) qs.set('regex', '1');
  if (params.case) qs.set('case', '1');
  if (params.word) qs.set('word', '1');
  const s = qs.toString();
  return app.request(`/api/worktrees/${sid}/search${s ? `?${s}` : ''}`);
}

describe('GET /api/worktrees/:sid/diff (against=base, default)', () => {
  let sid: string;
  let worktree: string;

  beforeAll(async () => {
    ({ sid, worktree } = await newSession('diff target'));
  });

  it('reports a modified tracked file and an added untracked file, against echoing the merge-base sha', async () => {
    writeFileSync(join(worktree, 'README.md'), '# fixture\nchanged\n');
    writeFileSync(join(worktree, 'untracked.txt'), 'new\n');

    const res = await diff(sid);
    expect(res.status).toBe(200);
    const body = diffResponseSchema.parse(await res.json());

    const expectedMergeBase = sh(worktree, 'merge-base', 'main', 'HEAD');
    expect(body.against).toBe(expectedMergeBase);
    expect(body.base_ref).toBe('main');

    const byPath = Object.fromEntries(body.entries.map((e) => [e.path, e.status]));
    expect(byPath['README.md']).toBe('modified');
    expect(byPath['untracked.txt']).toBe('added');
  });

  it('never lists .puddle/ files', async () => {
    mkdirSync(join(worktree, '.puddle'), { recursive: true });
    writeFileSync(join(worktree, '.puddle', 'note.txt'), 'internal\n');

    const res = await diff(sid);
    const body = diffResponseSchema.parse(await res.json());
    expect(body.entries.some((e) => e.path.startsWith('.puddle'))).toBe(false);
  });

  it('still shows the change once committed in the worktree', async () => {
    sh(worktree, 'add', 'untracked.txt');
    sh(worktree, 'commit', '-m', 'add untracked');

    const res = await diff(sid);
    const body = diffResponseSchema.parse(await res.json());
    expect(body.entries.some((e) => e.path === 'untracked.txt' && e.status === 'added')).toBe(true);
  });

  it('maps a git mv rename to renamed with old_path, diffed against the pre-rename commit', async () => {
    // A rename is only detectable in a two-tree diff when the origin path
    // actually exists in the tree being compared against: diffing vs. the
    // *base* merge-base wouldn't show this, because `untracked.txt` was
    // added after the merge-base too, so it would just read as `added`
    // under its final name. Diff against the commit that added it instead.
    writeFileSync(join(worktree, 'to-rename.txt'), 'stable content\n');
    sh(worktree, 'add', 'to-rename.txt');
    sh(worktree, 'commit', '-m', 'add to-rename.txt');
    const preRenameSha = sh(worktree, 'rev-parse', 'HEAD');

    sh(worktree, 'mv', 'to-rename.txt', 'was-renamed.txt');
    sh(worktree, 'commit', '-m', 'rename to-rename.txt to was-renamed.txt');

    const res = await diff(sid, preRenameSha);
    const body = diffResponseSchema.parse(await res.json());
    const renameEntry = body.entries.find((e) => e.status === 'renamed');
    expect(renameEntry).toMatchObject({ path: 'was-renamed.txt', old_path: 'to-rename.txt' });
  });
});

describe('GET /api/worktrees/:sid/diff?against=<sha>', () => {
  let sid: string;
  let firstSha: string;

  beforeAll(async () => {
    const created = await newSession('diff-against-sha target');
    sid = created.sid;
    firstSha = sh(created.worktree, 'rev-parse', 'HEAD');
  });

  it('works with the explicit first-commit sha', async () => {
    const res = await diff(sid, firstSha);
    expect(res.status).toBe(200);
    const body = diffResponseSchema.parse(await res.json());
    expect(body.against).toBe(firstSha);
    expect(body.base_ref).toBeNull();
  });

  it('404s an unknown sha', async () => {
    const res = await diff(sid, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(res.status).toBe(404);
    expect(errorCode(await res.json())).toBe('unknown_ref');
  });

  it('400s a non-sha-like against value (argv-injection guard)', async () => {
    const res = await diff(sid, '--upload-pack=x');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_against');
  });
});

describe('GET /api/worktrees/:sid/diff — base_ref resolves to origin/<base> with a remote', () => {
  let sid: string;

  beforeAll(async () => {
    const clonedPath = cloneRepo(fx.repoPath);
    const repo = fx.stores.repos.create({
      path: clonedPath,
      default_base_branch: 'main',
      onboarding_notes: null,
      fetch_enabled: true,
    });
    const project = fx.stores.projects.create({
      profile_id: fx.ids.profile,
      repo_id: repo.id,
      name: 'cloned-demo',
    });
    const session = await fx.service.create({
      project_id: project.id,
      account_id: fx.ids.account,
      title: 'origin target',
    });
    sessionIds.push(session.id);
    sid = session.id;
    await waitFor(() => fx.service.get(sid).status !== 'starting');
  });

  it('resolves base_ref to origin/main', async () => {
    const res = await diff(sid);
    const body = diffResponseSchema.parse(await res.json());
    expect(body.base_ref).toBe('origin/main');
  });
});

describe('GET /api/worktrees/:sid/diff?against=head (uncommitted only)', () => {
  let sid: string;
  let worktree: string;

  beforeAll(async () => {
    ({ sid, worktree } = await newSession('diff-head target'));
    // A committed change (part of HEAD) must NOT appear in the uncommitted view.
    commitFile(worktree, 'committed.txt', 'committed\n');
  });

  it('shows working-tree changes vs. HEAD and excludes committed changes', async () => {
    writeFileSync(join(worktree, 'README.md'), '# fixture\nedited\n'); // uncommitted edit
    writeFileSync(join(worktree, 'brand-new.txt'), 'new\n'); // untracked

    const res = await diff(sid, 'head');
    expect(res.status).toBe(200);
    const body = diffResponseSchema.parse(await res.json());
    expect(body.base_ref).toBe('HEAD');

    const byPath = Object.fromEntries(body.entries.map((e) => [e.path, e.status]));
    expect(byPath['README.md']).toBe('modified');
    expect(byPath['brand-new.txt']).toBe('added');
    // committed.txt is in HEAD, so it is not an uncommitted change.
    expect(byPath['committed.txt']).toBeUndefined();
  });
});

describe('protocol 15.3 repository-aware source control routes', () => {
  let sid: string;
  let worktree: string;
  let repository: string;

  beforeAll(async () => {
    ({ sid, worktree } = await newSession('source control target'));
    const reposRes = await app.request(`/api/worktrees/${sid}/git-repositories`);
    const repos = gitRepositoriesResponseSchema.parse(await reposRes.json());
    repository = repos.repositories[0]!.root;
  });

  it('keeps HEAD→index staged content separate from index→working content', async () => {
    writeFileSync(join(worktree, 'README.md'), 'staged version\n');
    sh(worktree, 'add', 'README.md');
    writeFileSync(join(worktree, 'README.md'), 'working version\n');

    const stagedRes = await app.request(`/api/worktrees/${sid}/diff?against=head&area=staged`);
    const staged = diffResponseSchema.parse(await stagedRes.json());
    expect(staged.area).toBe('staged');
    expect(staged.entries).toContainEqual(
      expect.objectContaining({ path: 'README.md', status: 'modified' }),
    );

    const unstagedRes = await app.request(`/api/worktrees/${sid}/diff?against=head&area=unstaged`);
    const unstaged = diffResponseSchema.parse(await unstagedRes.json());
    expect(unstaged.area).toBe('unstaged');
    expect(unstaged.entries).toContainEqual(
      expect.objectContaining({ path: 'README.md', status: 'modified' }),
    );

    const indexRes = await app.request(
      `/api/worktrees/${sid}/index-file?path=${encodeURIComponent('README.md')}`,
    );
    expect(indexFileResponseSchema.parse(await indexRes.json())).toMatchObject({
      exists: true,
      content: 'staged version\n',
    });

    const originalRes = await app.request(
      `/api/worktrees/${sid}/git-original?path=${encodeURIComponent('README.md')}`,
    );
    expect(gitOriginalResponseSchema.parse(await originalRes.json())).toMatchObject({
      exists: true,
      content: '# fixture\n',
    });
  });

  it('stages, unstages, and commits only the selected index content', async () => {
    writeFileSync(join(worktree, 'route-new.txt'), 'new\n');
    const stageRes = await app.request(`/api/worktrees/${sid}/git-stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository, paths: ['route-new.txt'] }),
    });
    expect(stageRes.status).toBe(200);

    const unstageRes = await app.request(`/api/worktrees/${sid}/git-unstage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository, paths: ['route-new.txt'] }),
    });
    expect(unstageRes.status).toBe(200);
    expect(sh(worktree, 'diff', '--cached', '--name-only')).not.toContain('route-new.txt');

    sh(worktree, 'add', 'route-new.txt');
    const commitRes = await app.request(`/api/worktrees/${sid}/git-commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository, message: 'route commit' }),
    });
    expect(commitRes.status).toBe(200);
    expect(sh(worktree, 'log', '-1', '--format=%s')).toBe('route commit');
    // README still has an unstaged post-index edit: committing did not stage it.
    expect(sh(worktree, 'diff', '--name-only')).toContain('README.md');
  });
});

describe('GET /api/worktrees/:sid/search', () => {
  let sid: string;
  let worktree: string;

  beforeAll(async () => {
    ({ sid, worktree } = await newSession('search target'));
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'alpha.ts'), 'export function authenticate() {}\n');
    writeFileSync(join(worktree, 'src', 'beta.ts'), '// call authenticate here\nconst x = 1;\n');
  });

  it('returns content matches grouped by file, plus filename matches', async () => {
    const res = await search(sid, { q: 'authenticate' });
    expect(res.status).toBe(200);
    const body = searchResponseSchema.parse(await res.json());
    const contentPaths = body.content.map((f) => f.path).sort();
    expect(contentPaths).toEqual(['src/alpha.ts', 'src/beta.ts']);
    const alpha = body.content.find((f) => f.path === 'src/alpha.ts')!;
    expect(alpha.matches[0]!.line).toBe(1);
    expect(alpha.matches[0]!.text).toContain('authenticate');
  });

  it('matches file names (untracked files included)', async () => {
    const res = await search(sid, { q: 'alpha' });
    const body = searchResponseSchema.parse(await res.json());
    expect(body.files).toContain('src/alpha.ts');
  });

  it('is case-insensitive by default and case-sensitive with case=1', async () => {
    const insensitive = searchResponseSchema.parse(
      await (await search(sid, { q: 'AUTHENTICATE' })).json(),
    );
    expect(insensitive.content.length).toBeGreaterThan(0);
    const sensitive = searchResponseSchema.parse(
      await (await search(sid, { q: 'AUTHENTICATE', case: true })).json(),
    );
    expect(sensitive.content).toHaveLength(0);
  });

  it('honours whole-word matching', async () => {
    const partial = searchResponseSchema.parse(
      await (await search(sid, { q: 'auth', word: true })).json(),
    );
    expect(partial.content).toHaveLength(0);
    const whole = searchResponseSchema.parse(
      await (await search(sid, { q: 'authenticate', word: true })).json(),
    );
    expect(whole.content.length).toBeGreaterThan(0);
  });

  it('supports regular expressions with regex=1', async () => {
    const body = searchResponseSchema.parse(
      await (await search(sid, { q: 'auth\\w+', regex: true })).json(),
    );
    expect(body.content.length).toBeGreaterThan(0);
  });

  it('400s an invalid regex rather than 500', async () => {
    const res = await search(sid, { q: '(', regex: true });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_search');
  });

  it('400s an empty query', async () => {
    const res = await search(sid, { q: '' });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('empty_query');
  });

  it('returns empty, untruncated results for a query with no matches', async () => {
    const body = searchResponseSchema.parse(
      await (await search(sid, { q: 'zznosuchtokenzz' })).json(),
    );
    expect(body.files).toHaveLength(0);
    expect(body.content).toHaveLength(0);
    expect(body.truncated).toBe(false);
  });
});

describe('GET /api/worktrees/:sid/file-at', () => {
  let sid: string;
  let worktree: string;
  let firstSha: string;

  beforeAll(async () => {
    ({ sid, worktree } = await newSession('file-at target'));
    firstSha = sh(worktree, 'rev-parse', 'HEAD');
  });

  it('content at the base sha differs from content at HEAD after a commit', async () => {
    writeFileSync(join(worktree, 'README.md'), '# updated\n');
    sh(worktree, 'add', 'README.md');
    sh(worktree, 'commit', '-m', 'update readme');

    const atBase = fileAtResponseSchema.parse(
      await (await fileAt(sid, firstSha, 'README.md')).json(),
    );
    const atHead = fileAtResponseSchema.parse(
      await (await fileAt(sid, 'HEAD', 'README.md')).json(),
    );
    expect(atBase.content).toBe('# fixture\n');
    expect(atHead.content).toBe('# updated\n');
  });

  it('is byte-exact for a file without a trailing newline', async () => {
    const content = 'no trailing newline';
    writeFileSync(join(worktree, 'no-newline.txt'), content);
    sh(worktree, 'add', 'no-newline.txt');
    sh(worktree, 'commit', '-m', 'add no-newline file');

    const body = fileAtResponseSchema.parse(
      await (await fileAt(sid, 'HEAD', 'no-newline.txt')).json(),
    );
    expect(body.content).toBe(content);
  });

  it('is byte-exact for a file with a trailing newline', async () => {
    const content = 'has trailing newline\n';
    writeFileSync(join(worktree, 'with-newline.txt'), content);
    sh(worktree, 'add', 'with-newline.txt');
    sh(worktree, 'commit', '-m', 'add with-newline file');

    const body = fileAtResponseSchema.parse(
      await (await fileAt(sid, 'HEAD', 'with-newline.txt')).json(),
    );
    expect(body.content).toBe(content);
  });

  it('detects a binary blob', async () => {
    const bytes = Buffer.concat([Buffer.from('lead'), Buffer.from([0x00]), Buffer.from('tail')]);
    writeFileSync(join(worktree, 'binary.bin'), bytes);
    sh(worktree, 'add', 'binary.bin');
    sh(worktree, 'commit', '-m', 'add binary file');

    const body = fileAtResponseSchema.parse(await (await fileAt(sid, 'HEAD', 'binary.bin')).json());
    expect(body.binary).toBe(true);
    expect(body.content).toBeNull();
  });

  it('404s a missing path at ref', async () => {
    const res = await fileAt(sid, 'HEAD', 'does-not-exist.txt');
    expect(res.status).toBe(404);
    expect(errorCode(await res.json())).toBe('not_at_ref');
  });

  it('400s a ref starting with -', async () => {
    const res = await fileAt(sid, '-x', 'README.md');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_ref');
  });

  it('400s a path that escapes the worktree', async () => {
    const res = await fileAt(sid, 'HEAD', '../x');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
  });
});

describe('GET /api/worktrees/:sid/log', () => {
  let sid: string;
  let shas: string[];

  beforeAll(async () => {
    const created = await newSession('log target');
    sid = created.sid;
    commitFile(created.worktree, 'a.txt', 'a\n');
    commitFile(created.worktree, 'b.txt', 'b\n');
    shas = sh(created.worktree, 'log', '--format=%H')
      .split('\n')
      .filter((s) => s.length > 0);
    expect(shas).toHaveLength(3); // b.txt, a.txt, initial README
  });

  it('matches git log sha-for-sha', async () => {
    const res = await logReq(sid, { limit: 10 });
    expect(res.status).toBe(200);
    const body = logResponseSchema.parse(await res.json());
    expect(body.commits.map((c) => c.sha)).toEqual(shas);
    expect(body.has_more).toBe(false);
  });

  it('limit=1&skip=1 returns the middle commit of three', async () => {
    const res = await logReq(sid, { limit: 1, skip: 1 });
    const body = logResponseSchema.parse(await res.json());
    expect(body.commits).toHaveLength(1);
    expect(body.commits[0]?.sha).toBe(shas[1]);
    expect(body.has_more).toBe(true);
  });

  it('has_more is false on the last page', async () => {
    const res = await logReq(sid, { limit: 1, skip: 2 });
    const body = logResponseSchema.parse(await res.json());
    expect(body.commits[0]?.sha).toBe(shas[2]);
    expect(body.has_more).toBe(false);
  });

  it('400s limit=0', async () => {
    const res = await logReq(sid, { limit: 0 });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_pagination');
  });

  it('400s limit=abc', async () => {
    const res = await logReq(sid, { limit: 'abc' });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_pagination');
  });
});

describe('GET /api/worktrees/:sid/show/:sha', () => {
  let sid: string;
  let rootSha: string;
  let secondSha: string;

  beforeAll(async () => {
    const created = await newSession('show target');
    sid = created.sid;
    rootSha = sh(created.worktree, 'rev-list', '--max-parents=0', 'HEAD').trim();
    secondSha = commitFile(created.worktree, 'shown.txt', 'shown content\n');
  });

  it('returns subject/author/body/parents/files for a known commit', async () => {
    const res = await show(sid, secondSha);
    expect(res.status).toBe(200);
    const body = showCommitResponseSchema.parse(await res.json());
    expect(body.commit.sha).toBe(secondSha);
    expect(body.commit.subject).toBe('add shown.txt');
    expect(body.commit.author_email).toBe('alice@example.com');
    expect(body.parents).toEqual([rootSha]);
    expect(body.files).toEqual([{ path: 'shown.txt', status: 'added', old_path: null }]);
  });

  it('works for the initial (--root) commit, with parents: []', async () => {
    const res = await show(sid, rootSha);
    expect(res.status).toBe(200);
    const body = showCommitResponseSchema.parse(await res.json());
    expect(body.parents).toEqual([]);
    expect(body.files.map((f) => f.path)).toContain('README.md');
  });

  it('404s an unknown sha', async () => {
    const res = await show(sid, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(res.status).toBe(404);
    expect(errorCode(await res.json())).toBe('unknown_ref');
  });

  it('400s an unsafe sha', async () => {
    const res = await show(sid, '-x');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_ref');
  });
});

describe('GET /api/sessions/:id — git_summary', () => {
  let sid: string;
  let worktree: string;

  beforeAll(async () => {
    ({ sid, worktree } = await newSession('git-summary target'));
  });

  it('starts at ahead:0 behind:0 dirty_files:0', async () => {
    const res = await app.request(`/api/sessions/${sid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { git_summary: unknown };
    expect(body.git_summary).toEqual({ ahead: 0, behind: 0, dirty_files: 0 });
  });

  it('ahead increments after a worktree commit', async () => {
    commitFile(worktree, 'ahead.txt', 'ahead\n');
    const res = await app.request(`/api/sessions/${sid}`);
    const body = (await res.json()) as { git_summary: { ahead: number } };
    expect(body.git_summary.ahead).toBe(1);
  });

  it('behind increments after a commit on the base branch in the canonical repo', async () => {
    commitFile(fx.repoPath, 'behind.txt', 'behind\n');
    const res = await app.request(`/api/sessions/${sid}`);
    const body = (await res.json()) as { git_summary: { behind: number } };
    expect(body.git_summary.behind).toBe(1);
  });

  it('dirty_files counts a modified file', async () => {
    writeFileSync(join(worktree, 'ahead.txt'), 'modified\n');
    const res = await app.request(`/api/sessions/${sid}`);
    const body = (await res.json()) as { git_summary: { dirty_files: number } };
    expect(body.git_summary.dirty_files).toBe(1);
  });

  it('is null once the worktree dir is removed', async () => {
    rmSync(worktree, { recursive: true, force: true });
    const res = await app.request(`/api/sessions/${sid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { git_summary: unknown };
    expect(body.git_summary).toBeNull();
  });

  it('the LIST endpoint does not carry git_summary', async () => {
    const res = await app.request(`/api/sessions?project=${fx.ids.project}`);
    const body = (await res.json()) as Array<{ git_summary?: unknown }>;
    expect(body.length).toBeGreaterThan(0);
    for (const s of body) expect(s.git_summary).toBeUndefined();
  });
});

describe('worktree-git: shared error conditions', () => {
  it('404s an unknown session on every endpoint', async () => {
    expect((await diff('no-such-session')).status).toBe(404);
    expect((await fileAt('no-such-session', 'HEAD', 'README.md')).status).toBe(404);
    expect((await logReq('no-such-session')).status).toBe(404);
    expect((await show('no-such-session', 'a'.repeat(40))).status).toBe(404);
    expect((await search('no-such-session', { q: 'x' })).status).toBe(404);
  });

  it('409s every endpoint once the worktree is gone from disk', async () => {
    const { sid, worktree } = await newSession('worktree-missing target');
    const sha = sh(worktree, 'rev-parse', 'HEAD');
    rmSync(worktree, { recursive: true, force: true });

    expect((await diff(sid)).status).toBe(409);
    expect((await fileAt(sid, 'HEAD', 'README.md')).status).toBe(409);
    expect((await logReq(sid)).status).toBe(409);
    expect((await show(sid, sha)).status).toBe(409);
  });
});
