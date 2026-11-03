import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fsOpResponseSchema, gitStatusResponseSchema } from '@puddle/shared';
import { worktreeRoutes } from '../../src/http/routes/worktrees/worktrees.js';
import { ApiError } from '../../src/http/errors.js';
import { fixture, waitFor, type Fixture } from '../helpers/daemon-fixtures.js';

let fx: Fixture;
let sessionId: string;
let worktree: string;
let app: Hono;

beforeAll(async () => {
  fx = fixture();
  const session = await fx.service.create({
    project_id: fx.ids.project,
    account_id: fx.ids.account,
    title: 'fs-ops target',
  });
  sessionId = session.id;
  await waitFor(() => fx.service.get(sessionId).status !== 'starting');
  worktree = fx.service.get(sessionId).worktree_path;

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
});

afterAll(async () => {
  await fx.service.kill(sessionId).catch(() => undefined);
});

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

function post(sid: string, op: string, body: unknown) {
  return app.request(`/api/worktrees/${sid}/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /:sid/create', () => {
  it('creates an empty file, making parents as needed', async () => {
    const res = await post(sessionId, 'create', { path: 'nested/dir/hello.txt', kind: 'file' });
    expect(res.status).toBe(201);
    const body = fsOpResponseSchema.parse(await res.json());
    expect(body.path).toBe('nested/dir/hello.txt');
    expect(readFileSync(join(worktree, 'nested/dir/hello.txt'), 'utf8')).toBe('');
  });

  it('creates an empty version 4 notebook', async () => {
    const res = await post(sessionId, 'create', { path: 'notebooks/new.IPYNB', kind: 'file' });
    expect(res.status).toBe(201);
    expect(JSON.parse(readFileSync(join(worktree, 'notebooks/new.IPYNB'), 'utf8'))).toEqual({
      cells: [],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    });
  });

  it('creates a folder', async () => {
    const res = await post(sessionId, 'create', { path: 'newdir', kind: 'dir' });
    expect(res.status).toBe(201);
    expect(statSync(join(worktree, 'newdir')).isDirectory()).toBe(true);
  });

  it('409s when the path already exists', async () => {
    writeFileSync(join(worktree, 'taken.txt'), 'x');
    const res = await post(sessionId, 'create', { path: 'taken.txt', kind: 'file' });
    expect(res.status).toBe(409);
    expect(errorCode(await res.json())).toBe('already_exists');
  });

  it('rejects an escape attempt', async () => {
    const res = await post(sessionId, 'create', { path: '../escape.txt', kind: 'file' });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
    expect(existsSync(join(worktree, '..', 'escape.txt'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'refuses names Windows cannot store, and backslash escapes, on Windows',
    async () => {
      for (const path of ['CON', 'docs/aux.md', 'nul.txt', 'f.txt:hidden', 'what?.txt', 'dot.']) {
        const res = await post(sessionId, 'create', { path, kind: 'file' });
        expect(res.status, path).toBe(400);
        expect(errorCode(await res.json()), path).toBe('invalid_name');
      }
      expect(existsSync(join(worktree, 'docs'))).toBe(false); // nothing written first
      for (const path of ['..\\escape.txt', 'D:escape.txt', '\\escape.txt']) {
        const res = await post(sessionId, 'create', { path, kind: 'file' });
        expect(errorCode(await res.json()), path).toBe('path_outside_worktree');
      }
      const nested = await post(sessionId, 'create', { path: 'win\\nested.txt', kind: 'file' });
      expect(fsOpResponseSchema.parse(await nested.json()).path).toBe('win/nested.txt');
    },
  );
});

describe('POST /:sid/rename', () => {
  it('moves a file to a new path', async () => {
    writeFileSync(join(worktree, 'from.txt'), 'move me\n');
    mkdirSync(join(worktree, 'dest'), { recursive: true });
    const res = await post(sessionId, 'rename', { from: 'from.txt', to: 'dest/to.txt' });
    expect(res.status).toBe(200);
    const body = fsOpResponseSchema.parse(await res.json());
    expect(body.path).toBe('dest/to.txt');
    expect(existsSync(join(worktree, 'from.txt'))).toBe(false);
    expect(readFileSync(join(worktree, 'dest/to.txt'), 'utf8')).toBe('move me\n');
  });

  it('404s when the source is missing', async () => {
    const res = await post(sessionId, 'rename', { from: 'ghost.txt', to: 'x.txt' });
    expect(res.status).toBe(404);
  });

  it('409s when the destination exists', async () => {
    writeFileSync(join(worktree, 'a.txt'), 'a');
    writeFileSync(join(worktree, 'b.txt'), 'b');
    const res = await post(sessionId, 'rename', { from: 'a.txt', to: 'b.txt' });
    expect(res.status).toBe(409);
    expect(errorCode(await res.json())).toBe('already_exists');
  });

  it('rejects an escaping destination', async () => {
    writeFileSync(join(worktree, 'src.txt'), 'x');
    const res = await post(sessionId, 'rename', { from: 'src.txt', to: '../out.txt' });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
  });

  it.runIf(process.platform === 'win32')(
    'renames by case alone on Windows, whose filesystem calls the target taken',
    async () => {
      writeFileSync(join(worktree, 'readme.md'), 'case\n');
      const res = await post(sessionId, 'rename', { from: 'readme.md', to: 'README.md' });
      expect(res.status).toBe(200);
      expect(readdirSync(worktree)).toContain('README.md');
      expect(readdirSync(worktree)).not.toContain('readme.md');
    },
  );

  it.runIf(process.platform === 'win32')(
    'answers 409 path_busy when another program holds an entry open on Windows',
    async () => {
      mkdirSync(join(worktree, 'held'), { recursive: true });
      // The child holds its working directory open once it is running.
      const holder = spawn(
        process.execPath,
        ['-e', "process.stdout.write('ready'); setTimeout(() => {}, 20000)"],
        { cwd: join(worktree, 'held') },
      );
      try {
        await new Promise((resolve) => holder.stdout.once('data', resolve));
        const rename = await post(sessionId, 'rename', { from: 'held', to: 'moved' });
        expect(rename.status).toBe(409);
        expect(errorCode(await rename.json())).toBe('path_busy');
        const remove = await post(sessionId, 'delete', { path: 'held' });
        expect(remove.status).toBe(409);
        expect(errorCode(await remove.json())).toBe('path_busy');
      } finally {
        holder.kill();
      }
    },
  );
});

describe('POST /:sid/copy', () => {
  it('copies a file with identical content', async () => {
    writeFileSync(join(worktree, 'orig.txt'), 'clone me\n');
    const res = await post(sessionId, 'copy', { from: 'orig.txt', to: 'dupe.txt' });
    expect(res.status).toBe(201);
    const body = fsOpResponseSchema.parse(await res.json());
    expect(body.path).toBe('dupe.txt');
    expect(readFileSync(join(worktree, 'dupe.txt'), 'utf8')).toBe('clone me\n');
  });

  it('auto-suffixes " copy" when the destination collides', async () => {
    writeFileSync(join(worktree, 'doc.md'), 'v1\n');
    // Paste into the same folder: to === from, so the name is taken.
    const res = await post(sessionId, 'copy', { from: 'doc.md', to: 'doc.md' });
    expect(res.status).toBe(201);
    const body = fsOpResponseSchema.parse(await res.json());
    expect(body.path).toBe('doc copy.md');
    expect(readFileSync(join(worktree, 'doc copy.md'), 'utf8')).toBe('v1\n');
  });

  it('copies a directory recursively', async () => {
    mkdirSync(join(worktree, 'folder/sub'), { recursive: true });
    writeFileSync(join(worktree, 'folder/sub/leaf.txt'), 'deep\n');
    const res = await post(sessionId, 'copy', { from: 'folder', to: 'folder-copy' });
    expect(res.status).toBe(201);
    expect(readFileSync(join(worktree, 'folder-copy/sub/leaf.txt'), 'utf8')).toBe('deep\n');
  });

  it('404s when the source is missing', async () => {
    const res = await post(sessionId, 'copy', { from: 'nope.txt', to: 'x.txt' });
    expect(res.status).toBe(404);
  });
});

describe('POST /:sid/transfer (protocol 16.3)', () => {
  let sourceRoot: string;
  let destinationRoot: string;

  beforeAll(() => {
    sourceRoot = mkdtempSync(join(tmpdir(), 'puddle-transfer-source-'));
    destinationRoot = mkdtempSync(join(tmpdir(), 'puddle-transfer-destination-'));
  });

  afterAll(() => {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(destinationRoot, { recursive: true, force: true });
  });

  function transfer(
    body: {
      operation: 'copy' | 'move';
      source: { session_id: string; root?: string };
      from: string;
      to: string;
    },
    root = destinationRoot,
  ) {
    return app.request(`/api/worktrees/${sessionId}/transfer?root=${encodeURIComponent(root)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function request(operation: 'copy' | 'move', from = 'notes.txt', to = 'inbox/notes.txt') {
    return {
      operation,
      source: { session_id: sessionId, root: sourceRoot },
      from,
      to,
    } as const;
  }

  it('copies between independent roots and suffixes a collision', async () => {
    writeFileSync(join(sourceRoot, 'notes.txt'), 'portable\n');

    const copied = await transfer(request('copy'));
    expect(copied.status).toBe(201);
    expect(fsOpResponseSchema.parse(await copied.json()).path).toBe('inbox/notes.txt');
    expect(readFileSync(join(destinationRoot, 'inbox/notes.txt'), 'utf8')).toBe('portable\n');
    expect(readFileSync(join(sourceRoot, 'notes.txt'), 'utf8')).toBe('portable\n');

    const collision = await transfer(request('copy'));
    expect(collision.status).toBe(201);
    expect(fsOpResponseSchema.parse(await collision.json()).path).toBe('inbox/notes copy.txt');
  });

  it('moves between roots without deleting a source when the destination collides', async () => {
    writeFileSync(join(sourceRoot, 'move.txt'), 'move me\n');
    const moved = await transfer(request('move', 'move.txt', 'moved.txt'));
    expect(moved.status).toBe(200);
    expect(existsSync(join(sourceRoot, 'move.txt'))).toBe(false);
    expect(readFileSync(join(destinationRoot, 'moved.txt'), 'utf8')).toBe('move me\n');

    writeFileSync(join(sourceRoot, 'kept.txt'), 'keep me\n');
    writeFileSync(join(destinationRoot, 'taken.txt'), 'taken\n');
    const conflict = await transfer(request('move', 'kept.txt', 'taken.txt'));
    expect(conflict.status).toBe(409);
    expect(errorCode(await conflict.json())).toBe('already_exists');
    expect(readFileSync(join(sourceRoot, 'kept.txt'), 'utf8')).toBe('keep me\n');
  });

  it('confines source and destination paths independently', async () => {
    writeFileSync(join(sourceRoot, 'safe.txt'), 'safe\n');

    const sourceEscape = await transfer(request('copy', '../outside.txt', 'inside.txt'));
    expect(sourceEscape.status).toBe(400);
    expect(errorCode(await sourceEscape.json())).toBe('path_outside_worktree');

    const destinationEscape = await transfer(request('copy', 'safe.txt', '../outside.txt'));
    expect(destinationEscape.status).toBe(400);
    expect(errorCode(await destinationEscape.json())).toBe('path_outside_worktree');
  });

  it('rejects a directory copied into itself without creating destination parents', async () => {
    mkdirSync(join(sourceRoot, 'folder'), { recursive: true });
    writeFileSync(join(sourceRoot, 'folder/leaf.txt'), 'leaf\n');

    const res = await transfer(request('copy', 'folder', 'folder/nested/folder'), sourceRoot);
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_destination');
    expect(existsSync(join(sourceRoot, 'folder/nested'))).toBe(false);
  });
});

describe('POST /:sid/delete', () => {
  it('removes a file', async () => {
    writeFileSync(join(worktree, 'trash.txt'), 'bye');
    const res = await post(sessionId, 'delete', { path: 'trash.txt' });
    expect(res.status).toBe(200);
    expect(existsSync(join(worktree, 'trash.txt'))).toBe(false);
  });

  it('removes a directory recursively', async () => {
    mkdirSync(join(worktree, 'doomed/inner'), { recursive: true });
    writeFileSync(join(worktree, 'doomed/inner/f.txt'), 'x');
    const res = await post(sessionId, 'delete', { path: 'doomed' });
    expect(res.status).toBe(200);
    expect(existsSync(join(worktree, 'doomed'))).toBe(false);
  });

  it('404s a missing path', async () => {
    const res = await post(sessionId, 'delete', { path: 'never-existed' });
    expect(res.status).toBe(404);
  });

  it('rejects an escape attempt', async () => {
    const res = await post(sessionId, 'delete', { path: '../../etc' });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
  });
});

describe('browse root override on the mutations (?root=, protocol 12.3)', () => {
  let outside: string;

  beforeAll(() => {
    outside = mkdtempSync(join(tmpdir(), 'puddle-fs-ops-browse-'));
    mkdirSync(join(outside, 'notes'), { recursive: true });
    writeFileSync(join(outside, 'notes', 'todo.md'), 'remember\n');
  });
  afterAll(() => rmSync(outside, { recursive: true, force: true }));

  /** Same POST, with the override — the browse tree's every mutation. */
  function rooted(op: string, body: unknown, root = outside) {
    return app.request(`/api/worktrees/${sessionId}/${op}?root=${encodeURIComponent(root)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('creates, renames, copies and deletes under the override', async () => {
    const created = await rooted('create', { path: 'notes/fresh.txt', kind: 'file' });
    expect(created.status).toBe(201);
    // The response path is relative to the OVERRIDE, so the client can select it.
    expect(fsOpResponseSchema.parse(await created.json()).path).toBe('notes/fresh.txt');
    expect(existsSync(join(outside, 'notes', 'fresh.txt'))).toBe(true);
    // The worktree is untouched — the whole reason the override exists.
    expect(existsSync(join(worktree, 'notes', 'fresh.txt'))).toBe(false);

    const renamed = await rooted('rename', { from: 'notes/fresh.txt', to: 'notes/moved.txt' });
    expect(renamed.status).toBe(200);
    expect(fsOpResponseSchema.parse(await renamed.json()).path).toBe('notes/moved.txt');
    expect(existsSync(join(outside, 'notes', 'moved.txt'))).toBe(true);

    const copied = await rooted('copy', { from: 'notes/moved.txt', to: 'notes/moved.txt' });
    expect(copied.status).toBe(201);
    expect(fsOpResponseSchema.parse(await copied.json()).path).toBe('notes/moved copy.txt');

    const deleted = await rooted('delete', { path: 'notes/moved.txt' });
    expect(deleted.status).toBe(200);
    expect(existsSync(join(outside, 'notes', 'moved.txt'))).toBe(false);
  });

  it('creates a directory tree under the override', async () => {
    const res = await rooted('create', { path: 'deep/er/still', kind: 'dir' });
    expect(res.status).toBe(201);
    expect(statSync(join(outside, 'deep/er/still')).isDirectory()).toBe(true);
  });

  it('confines every path to the OVERRIDDEN root, not the worktree', async () => {
    for (const [op, body] of [
      ['create', { path: '../escaped.txt', kind: 'file' }],
      ['rename', { from: 'notes/todo.md', to: '../escaped.md' }],
      ['copy', { from: 'notes/todo.md', to: '../escaped.md' }],
      ['delete', { path: '../notes' }],
    ] as const) {
      const res = await rooted(op, body);
      expect(res.status, op).toBe(400);
      expect(errorCode(await res.json()), op).toBe('path_outside_worktree');
    }
    expect(existsSync(join(outside, '..', 'escaped.txt'))).toBe(false);
  });

  it('rejects a relative or missing root, like the read routes', async () => {
    const rel = await rooted('create', { path: 'x.txt', kind: 'file' }, 'notes');
    expect(rel.status).toBe(400);
    expect(errorCode(await rel.json())).toBe('invalid_root');

    const gone = await rooted('create', { path: 'x.txt', kind: 'file' }, join(outside, 'absent'));
    expect(gone.status).toBe(404);
  });

  it('leaves the worktree as the root when no override is given', async () => {
    const res = await post(sessionId, 'create', { path: 'plain.txt', kind: 'file' });
    expect(res.status).toBe(201);
    expect(existsSync(join(worktree, 'plain.txt'))).toBe(true);
    expect(existsSync(join(outside, 'plain.txt'))).toBe(false);
  });
});

describe('GET /:sid/git-status', () => {
  it('reports untracked and ignored files distinctly', async () => {
    writeFileSync(join(worktree, 'brand-new.txt'), 'hello\n');
    writeFileSync(join(worktree, '.gitignore'), 'ignored-here.log\n');
    writeFileSync(join(worktree, 'ignored-here.log'), 'noise\n');

    const res = await app.request(`/api/worktrees/${sessionId}/git-status`);
    expect(res.status).toBe(200);
    const body = gitStatusResponseSchema.parse(await res.json());
    const byPath = new Map(body.entries.map((e) => [e.path, e.status]));
    expect(byPath.get('brand-new.txt')).toBe('untracked');
    expect(byPath.get('ignored-here.log')).toBe('ignored');
  });
});
