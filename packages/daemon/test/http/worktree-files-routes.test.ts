import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, parse } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as yauzl from 'yauzl';
import {
  fileResponseSchema,
  previewAssetResponseSchema,
  MAX_PREVIEW_ASSET_BYTES,
  putFileResponseSchema,
  treeResponseSchema,
  uploadResponseSchema,
} from '@puddle/shared';
import { worktreeRoutes } from '../../src/http/routes/worktrees/worktrees.js';
import { ApiError } from '../../src/http/errors.js';
import { fixture, waitFor, type Fixture } from '../helpers/daemon-fixtures.js';

let fx: Fixture;
let sessionId: string;
let worktree: string;
let app: Hono;

/** Windows creates file symlinks only under Developer Mode or elevation. */
const fileSymlinks = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-link-probe-'));
  try {
    symlinkSync(join(dir, 'missing'), join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

/** A directory link: a junction on Windows, which needs no privilege and lists as a symlink. */
function linkDirectory(target: string, path: string): void {
  if (process.platform === 'win32') symlinkSync(target, path, 'junction');
  else symlinkSync(target, path);
}

beforeAll(async () => {
  fx = fixture();
  const session = await fx.service.create({
    project_id: fx.ids.project,
    account_id: fx.ids.account,
    title: 'file explorer target',
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
  await fx.service.kill(sessionId).catch(() => undefined); // reap the fake agent's PTY
});

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

function tree(sid: string, path?: string) {
  const qs = path === undefined ? '' : `?path=${encodeURIComponent(path)}`;
  return app.request(`/api/worktrees/${sid}/tree${qs}`);
}

function getFile(sid: string, path: string) {
  return app.request(`/api/worktrees/${sid}/file?path=${encodeURIComponent(path)}`);
}

function putFile(sid: string, path: string, body: unknown) {
  return app.request(`/api/worktrees/${sid}/file?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function download(sid: string, path: string) {
  return app.request(`/api/worktrees/${sid}/download?path=${encodeURIComponent(path)}`);
}

function upload(sid: string, dir: string, form: FormData) {
  return app.request(`/api/worktrees/${sid}/upload?dir=${encodeURIComponent(dir)}`, {
    method: 'POST',
    body: form,
  });
}

describe('GET /api/worktrees/:sid/tree', () => {
  beforeAll(() => {
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(worktree, 'README.md'), '# demo\n');
    writeFileSync(join(worktree, 'apple.txt'), 'a\n');
  });

  it('lists the root sorted dirs-first, case-insensitive, and hides .git', async () => {
    const res = await tree(sessionId);
    expect(res.status).toBe(200);
    const body = treeResponseSchema.parse(await res.json());
    expect(body.path).toBe('');
    const names = body.entries.map((e) => e.name);
    expect(names).not.toContain('.git');
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    expect(names).toContain('apple.txt');
    const srcEntry = body.entries.find((e) => e.name === 'src');
    expect(srcEntry).toMatchObject({ type: 'dir', size: null });
    // dirs-first
    const firstFileIdx = body.entries.findIndex((e) => e.type !== 'dir');
    const lastDirIdx = body.entries.map((e) => e.type).lastIndexOf('dir');
    expect(lastDirIdx).toBeLessThan(firstFileIdx === -1 ? Infinity : firstFileIdx);
    // case-insensitive alpha among files: README.md before apple.txt would fail
    // case-sensitive sort ('R' < 'a'); case-insensitive puts apple before README.
    const fileNames = body.entries.filter((e) => e.type === 'file').map((e) => e.name);
    expect(fileNames.indexOf('apple.txt')).toBeLessThan(fileNames.indexOf('README.md'));
  });

  it('lists a nested path', async () => {
    const res = await tree(sessionId, 'src');
    const body = treeResponseSchema.parse(await res.json());
    expect(body.entries.map((e) => e.name)).toEqual(['index.ts']);
  });

  // Needs a file symlink, which an unprivileged Windows account cannot create.
  it.skipIf(!fileSymlinks)(
    'resolves an in-worktree symlink to a file, flagged as a link',
    async () => {
      symlinkSync(join(worktree, 'apple.txt'), join(worktree, 'link-to-apple'));
      const res = await tree(sessionId);
      const body = treeResponseSchema.parse(await res.json());
      const link = body.entries.find((e) => e.name === 'link-to-apple');
      // Resolves to the target's kind (a file) so it opens, but stays flagged.
      expect(link).toMatchObject({ type: 'file', symlink: true });
    },
  );

  it('resolves an in-worktree symlink to a directory as explorable', async () => {
    linkDirectory(join(worktree, 'src'), join(worktree, 'link-to-src'));
    const res = await tree(sessionId);
    const body = treeResponseSchema.parse(await res.json());
    const link = body.entries.find((e) => e.name === 'link-to-src');
    expect(link).toMatchObject({ type: 'dir', size: null, symlink: true });
    // …and listing through the link yields the target directory's children.
    const inner = treeResponseSchema.parse(await (await tree(sessionId, 'link-to-src')).json());
    expect(inner.entries.map((e) => e.name)).toEqual(['index.ts']);
  });

  it('follows a symlink whose directory target is outside the worktree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'puddle-escape-'));
    mkdirSync(join(outside, 'nested'), { recursive: true });
    writeFileSync(join(outside, 'nested', 'far.txt'), 'over here\n');
    linkDirectory(join(outside, 'nested'), join(worktree, 'escape-dir'));
    const res = await tree(sessionId);
    const body = treeResponseSchema.parse(await res.json());
    const link = body.entries.find((e) => e.name === 'escape-dir');
    // Resolved to its target kind and explorable — a symlink is a real object
    // the user placed in the worktree, so following it out is intended.
    expect(link).toMatchObject({ type: 'dir', size: null, symlink: true });
    const inner = treeResponseSchema.parse(await (await tree(sessionId, 'escape-dir')).json());
    expect(inner.entries.map((e) => e.name)).toEqual(['far.txt']);
    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a relative traversal', async () => {
    const res = await tree(sessionId, '../..');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
  });

  it('rejects an absolute path', async () => {
    const res = await tree(sessionId, '/etc');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
  });

  it('rejects a URL-encoded traversal', async () => {
    const res = await app.request(`/api/worktrees/${sessionId}/tree?path=..%2f..%2f`);
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
  });

  it('400s when the path is a file, not a directory', async () => {
    const res = await tree(sessionId, 'apple.txt');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('not_a_directory');
  });

  it('404s an unknown session', async () => {
    const res = await tree('no-such-session');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/worktrees/:sid/file', () => {
  it('round-trips content and mtime_ms', async () => {
    writeFileSync(join(worktree, 'hello.txt'), 'hello world\n');
    const res = await getFile(sessionId, 'hello.txt');
    expect(res.status).toBe(200);
    const body = fileResponseSchema.parse(await res.json());
    expect(body.content).toBe('hello world\n');
    expect(body.binary).toBe(false);
    expect(body.size).toBe(12);
    expect(typeof body.mtime_ms).toBe('number');
  });

  it('404s a missing file', async () => {
    const res = await getFile(sessionId, 'does-not-exist.txt');
    expect(res.status).toBe(404);
    expect(errorCode(await res.json())).toBe('not_found');
  });

  it('400s a directory path', async () => {
    const res = await getFile(sessionId, 'src');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('not_a_file');
  });

  it('detects a NUL byte within the first 8 KiB as binary', async () => {
    const bytes = Buffer.concat([Buffer.from('lead-in'), Buffer.from([0x00]), Buffer.from('tail')]);
    writeFileSync(join(worktree, 'binary.bin'), bytes);
    const res = await getFile(sessionId, 'binary.bin');
    const body = fileResponseSchema.parse(await res.json());
    expect(body.binary).toBe(true);
    expect(body.content).toBeNull();
    expect(body.size).toBe(bytes.byteLength);
  });

  it('413s a file above the 5 MiB cap', async () => {
    writeFileSync(join(worktree, 'huge.bin'), Buffer.alloc(5 * 1024 * 1024 + 1));
    const res = await getFile(sessionId, 'huge.bin');
    expect(res.status).toBe(413);
    expect(errorCode(await res.json())).toBe('file_too_large');
  });

  // Needs a file symlink, which an unprivileged Windows account cannot create.
  it.skipIf(!fileSymlinks)(
    'reads and writes through a symlink whose file target is outside the worktree',
    async () => {
      // The request path is a plain in-worktree name; the symlink resolves out.
      // Following it is intended (read + write) — only lexical `..`/absolute
      // escapes are rejected, never a real symlink the user placed here.
      const outside = mkdtempSync(join(tmpdir(), 'puddle-outside-'));
      const target = join(outside, 'shared.txt');
      writeFileSync(target, 'shared v1\n');
      symlinkSync(target, join(worktree, 'shared-link.txt'));

      const read = await getFile(sessionId, 'shared-link.txt');
      expect(read.status).toBe(200);
      expect(fileResponseSchema.parse(await read.json()).content).toBe('shared v1\n');

      const write = await app.request(`/api/worktrees/${sessionId}/file?path=shared-link.txt`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'shared v2\n' }),
      });
      expect(write.status).toBe(200);
      // The write lands on the external target the symlink points at.
      expect(readFileSync(target, 'utf8')).toBe('shared v2\n');
      rmSync(outside, { recursive: true, force: true });
    },
  );
});

describe('PUT /api/worktrees/:sid/file', () => {
  it('writes content visible via a direct readFileSync', async () => {
    const res = await putFile(sessionId, 'edited.txt', { content: 'v1\n' });
    expect(res.status).toBe(200);
    const body = putFileResponseSchema.parse(await res.json());
    expect(readFileSync(join(worktree, 'edited.txt'), 'utf8')).toBe('v1\n');
    expect(body.size).toBe(3);
  });

  it('creates a new file', async () => {
    const res = await putFile(sessionId, 'brand-new.txt', { content: 'fresh\n' });
    expect(res.status).toBe(200);
    expect(readFileSync(join(worktree, 'brand-new.txt'), 'utf8')).toBe('fresh\n');
  });

  it('initialises a blank notebook on Save As but preserves subsequent literal saves', async () => {
    expect((await putFile(sessionId, 'new-notebook.ipynb', { content: '  \n' })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(worktree, 'new-notebook.ipynb'), 'utf8'))).toEqual({
      cells: [],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    });
    expect((await putFile(sessionId, 'new-notebook.ipynb', { content: '' })).status).toBe(200);
    expect(readFileSync(join(worktree, 'new-notebook.ipynb'), 'utf8')).toBe('');
    expect(
      (await putFile(sessionId, 'literal-notebook.ipynb', { content: 'invalid JSON' })).status,
    ).toBe(200);
    expect(readFileSync(join(worktree, 'literal-notebook.ipynb'), 'utf8')).toBe('invalid JSON');
  });

  it('409s on a stale expected_mtime_ms', async () => {
    const first = putFileResponseSchema.parse(
      await (await putFile(sessionId, 'concurrent.txt', { content: 'v1\n' })).json(),
    );
    // Simulate another writer changing the file after the editor loaded it.
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(join(worktree, 'concurrent.txt'), 'someone-else\n');

    const res = await putFile(sessionId, 'concurrent.txt', {
      content: 'my-edit\n',
      expected_mtime_ms: first.mtime_ms,
    });
    expect(res.status).toBe(409);
    expect(errorCode(await res.json())).toBe('stale_file');
    expect(readFileSync(join(worktree, 'concurrent.txt'), 'utf8')).toBe('someone-else\n');
  });

  it('an unconditional PUT succeeds after the stale rejection ("Overwrite anyway")', async () => {
    const res = await putFile(sessionId, 'concurrent.txt', { content: 'overwritten\n' });
    expect(res.status).toBe(200);
    expect(readFileSync(join(worktree, 'concurrent.txt'), 'utf8')).toBe('overwritten\n');
  });

  it('400s when the parent directory does not exist', async () => {
    const res = await putFile(sessionId, 'no-such-dir/file.txt', { content: 'x\n' });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('not_a_directory');
  });
});

describe('POST /api/worktrees/:sid/upload', () => {
  it('lands two multipart files in dir=, neutralising any path in the filename', async () => {
    mkdirSync(join(worktree, 'uploads'), { recursive: true });
    const form = new FormData();
    form.set('a', new File(['one'], 'one.txt'));
    form.set('b', new File(['two-longer'], '../../evil.txt'));

    const res = await upload(sessionId, 'uploads', form);
    expect(res.status).toBe(201);
    const body = uploadResponseSchema.parse(await res.json());
    expect(body.files).toHaveLength(2);

    expect(readFileSync(join(worktree, 'uploads', 'one.txt'), 'utf8')).toBe('one');
    expect(readFileSync(join(worktree, 'uploads', 'evil.txt'), 'utf8')).toBe('two-longer');
    expect(existsSync(join(worktree, 'evil.txt'))).toBe(false);
  });

  it('rebuilds a folder drop: relative filenames create their directories under dir=', async () => {
    mkdirSync(join(worktree, 'uploads'), { recursive: true });
    const form = new FormData();
    form.set('a', new File(['deep'], 'photos/cats/one.png'));
    form.set('b', new File(['sneaky'], 'photos/../../../etc/passwd'));

    const res = await upload(sessionId, 'uploads', form);
    expect(res.status).toBe(201);
    const body = uploadResponseSchema.parse(await res.json());
    expect(body.files.map((f) => f.path).sort()).toEqual([
      'uploads/photos/cats/one.png',
      'uploads/photos/etc/passwd',
    ]);

    expect(readFileSync(join(worktree, 'uploads', 'photos', 'cats', 'one.png'), 'utf8')).toBe(
      'deep',
    );
    // `..` segments are dropped, never resolved — the write stays inside dir=.
    expect(readFileSync(join(worktree, 'uploads', 'photos', 'etc', 'passwd'), 'utf8')).toBe(
      'sneaky',
    );
    expect(existsSync(join(worktree, 'etc'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'splits names on backslashes too and refuses the batch before writing a name Windows cannot store',
    async () => {
      mkdirSync(join(worktree, 'uploads-win'), { recursive: true });
      const sneaky = new FormData();
      sneaky.set('a', new File(['sneaky'], 'photos\\..\\..\\..\\evil.txt'));
      const ok = await upload(sessionId, 'uploads-win', sneaky);
      expect(uploadResponseSchema.parse(await ok.json()).files.map((f) => f.path)).toEqual([
        'uploads-win/photos/evil.txt',
      ]);
      expect(existsSync(join(worktree, 'evil.txt'))).toBe(false);

      const mixed = new FormData();
      mixed.set('a', new File(['fine'], 'fine.txt'));
      mixed.set('b', new File(['bad'], 'notes:2024.txt'));
      const res = await upload(sessionId, 'uploads-win', mixed);
      expect(res.status).toBe(400);
      expect(errorCode(await res.json())).toBe('invalid_name');
      expect(existsSync(join(worktree, 'uploads-win', 'fine.txt'))).toBe(false);
    },
  );

  it('400s when dir does not exist', async () => {
    const form = new FormData();
    form.set('a', new File(['x'], 'x.txt'));
    const res = await upload(sessionId, 'missing-dir', form);
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('not_a_directory');
  });

  it('400s nothing_uploaded when the form has no files', async () => {
    const form = new FormData();
    form.set('note', 'not a file');
    const res = await upload(sessionId, 'uploads', form);
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('nothing_uploaded');
  });

  it('413s an oversize content-length header without writing a body', async () => {
    const res = await app.request(`/api/worktrees/${sessionId}/upload?dir=uploads`, {
      method: 'POST',
      headers: {
        'content-length': String(513 * 1024 * 1024),
        'content-type': 'multipart/form-data',
      },
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(413);
    expect(errorCode(await res.json())).toBe('upload_too_large');
  });
});

describe('GET /api/worktrees/:sid/download', () => {
  it('streams identical bytes for a single file', async () => {
    const original = readFileSync(join(worktree, 'apple.txt'));
    const res = await download(sessionId, 'apple.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain(`filename*=UTF-8''apple.txt`);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes).toEqual(original);
  });

  it('zips a directory, excluding .git, with the right entries and content-disposition', async () => {
    const res = await download(sessionId, 'src');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain(`filename*=UTF-8''src.zip`);

    const zipBytes = Buffer.from(await res.arrayBuffer());
    const entries = await new Promise<string[]>((resolvePromise, reject) => {
      yauzl.fromBuffer(zipBytes, { lazyEntries: true }, (err, zipfile) => {
        if (err || !zipfile) return reject(err);
        const names: string[] = [];
        zipfile.on('entry', (entry) => {
          names.push(entry.fileName);
          zipfile.readEntry();
        });
        zipfile.on('end', () => resolvePromise(names));
        zipfile.on('error', reject);
        zipfile.readEntry();
      });
    });
    expect(entries).toContain('index.ts');
    expect(entries.some((n) => n.includes('.git'))).toBe(false);
  });
});

describe('GET /api/worktrees/:sid/media', () => {
  function media(sid: string, path: string) {
    return app.request(`/api/worktrees/${sid}/media?path=${encodeURIComponent(path)}`);
  }

  it('serves a known media type inline with its real content-type and identical bytes', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]); // fake PNG-ish
    writeFileSync(join(worktree, 'pic.png'), bytes);
    const res = await media(sessionId, 'pic.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toContain('inline');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });

  it('falls back to octet-stream for an unknown extension', async () => {
    writeFileSync(join(worktree, 'thing.xyz'), 'data');
    const res = await media(sessionId, 'thing.xyz');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('400s a directory and rejects an escape', async () => {
    expect((await media(sessionId, 'src')).status).toBe(400);
    const escape = await media(sessionId, '../../etc/hosts');
    expect(escape.status).toBe(400);
    expect(errorCode(await escape.json())).toBe('path_outside_worktree');
  });
});

describe('bounded preview assets', () => {
  const asset = (path: string, root?: string, sid = sessionId) =>
    app.request(
      `/api/worktrees/${sid}/preview-asset?${new URLSearchParams({ path, ...(root ? { root } : {}) })}`,
    );

  it('preserves binary bytes and MIME, and accepts validated directory targets', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'puddle-preview-'));
    try {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]);
      writeFileSync(join(outside, 'asset.png'), bytes);
      const response = await asset('asset.png', outside, '00000000-0000-0000-0000-000000000000');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const result = previewAssetResponseSchema.parse(await response.json());
      expect(result.mime).toBe('image/png');
      expect(Buffer.from(result.data, 'base64')).toEqual(bytes);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects large assets, directories, traversal and invalid roots', async () => {
    writeFileSync(join(worktree, 'large-preview.png'), Buffer.alloc(MAX_PREVIEW_ASSET_BYTES + 1));
    const large = await asset('large-preview.png');
    expect(large.status).toBe(413);
    expect(errorCode(await large.json())).toBe('preview_too_large');
    expect((await asset('.')).status).toBe(400);
    expect((await asset('../outside')).status).toBe(400);
    expect((await asset('missing')).status).toBe(404);
    expect((await asset('asset.png', 'relative')).status).toBe(400);
  });
});

describe('read-only browse root override (?root=, protocol 10.2)', () => {
  let outside: string;

  beforeAll(() => {
    outside = mkdtempSync(join(tmpdir(), 'puddle-browse-'));
    mkdirSync(join(outside, 'notes'));
    writeFileSync(join(outside, 'notes', 'todo.md'), 'remember\n');
  });
  afterAll(() => rmSync(outside, { recursive: true, force: true }));

  it('lists and reads outside the worktree under the override', async () => {
    const res = await app.request(
      `/api/worktrees/${sessionId}/tree?path=&root=${encodeURIComponent(outside)}`,
    );
    expect(res.status).toBe(200);
    const body = treeResponseSchema.parse(await res.json());
    expect(body.entries.map((e) => e.name)).toContain('notes');

    const file = await app.request(
      `/api/worktrees/${sessionId}/file?path=notes%2Ftodo.md&root=${encodeURIComponent(outside)}`,
    );
    expect(file.status).toBe(200);
    expect(fileResponseSchema.parse(await file.json()).content).toBe('remember\n');
  });

  it('rejects a relative or missing root', async () => {
    const rel = await app.request(`/api/worktrees/${sessionId}/tree?path=&root=notes`);
    expect(rel.status).toBe(400);
    expect(errorCode(await rel.json())).toBe('invalid_root');

    const gone = await app.request(
      `/api/worktrees/${sessionId}/tree?path=&root=${encodeURIComponent(join(outside, 'absent'))}`,
    );
    expect(gone.status).toBe(404);
  });

  it('browses the filesystem root, whose children are not escapes', async () => {
    // The regression: the containment prefix was built as `root + sep`, which
    // for `/` is `//` — so every child of the filesystem root, i.e. everything
    // reachable by walking the browse tree to the top, was rejected outright.
    // On Windows the top is the drive root, whose listing includes system
    // files (pagefile.sys) that refuse even lstat.
    const top = process.platform === 'win32' ? parse(outside).root : '/';
    const root = encodeURIComponent(top);
    const listing = await app.request(`/api/worktrees/${sessionId}/tree?path=&root=${root}`);
    expect(listing.status).toBe(200);
    expect(treeResponseSchema.parse(await listing.json()).entries.length).toBeGreaterThan(0);

    // …and descending into one of them works, which is what the tree does on
    // expand. `outside` is an absolute tmpdir path, so walk to it from `/`.
    const rel =
      process.platform === 'win32'
        ? outside.slice(top.length).replaceAll('\\', '/')
        : outside.replace(/^\//, '');
    const deep = await app.request(
      `/api/worktrees/${sessionId}/tree?path=${encodeURIComponent(rel)}&root=${root}`,
    );
    expect(deep.status).toBe(200);
    expect(treeResponseSchema.parse(await deep.json()).entries.map((e) => e.name)).toContain(
      'notes',
    );

    const file = await app.request(
      `/api/worktrees/${sessionId}/file?path=${encodeURIComponent(`${rel}/notes/todo.md`)}&root=${root}`,
    );
    expect(file.status).toBe(200);
  });

  it.runIf(process.platform === 'win32')(
    'stops at a drive root on Windows: a bare drive is its root, and / names no directory',
    async () => {
      const drive = parse(outside).root.slice(0, 2); // `C:`
      const bare = await app.request(`/api/worktrees/${sessionId}/tree?path=&root=${drive}`);
      expect(bare.status).toBe(200);
      const atRoot = await app.request(
        `/api/worktrees/${sessionId}/tree?path=&root=${encodeURIComponent(`${drive}\\`)}`,
      );
      expect(treeResponseSchema.parse(await bare.json()).entries).toEqual(
        treeResponseSchema.parse(await atRoot.json()).entries,
      );
      for (const root of ['/', '\\Users', `${drive}Users`]) {
        const res = await app.request(
          `/api/worktrees/${sessionId}/tree?path=&root=${encodeURIComponent(root)}`,
        );
        expect(res.status, root).toBe(400);
        expect(errorCode(await res.json())).toBe('invalid_root');
      }
    },
  );

  it('accepts a root with a trailing separator', async () => {
    const res = await app.request(
      `/api/worktrees/${sessionId}/tree?path=notes&root=${encodeURIComponent(`${outside}/`)}`,
    );
    expect(res.status).toBe(200);
    expect(treeResponseSchema.parse(await res.json()).entries.map((e) => e.name)).toContain(
      'todo.md',
    );
  });

  it('still rejects a sibling that merely shares the root prefix', async () => {
    // `/x` must not admit `/x-evil`: the fix derives the prefix, it does not
    // drop the separator check.
    const sibling = `${outside}-evil`;
    mkdirSync(sibling, { recursive: true });
    try {
      const res = await app.request(
        `/api/worktrees/${sessionId}/file?path=..%2F${encodeURIComponent(`${basename(sibling)}/x`)}&root=${encodeURIComponent(outside)}`,
      );
      expect(res.status).toBe(400);
      expect(errorCode(await res.json())).toBe('path_outside_worktree');
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('still confines paths under the OVERRIDDEN root', async () => {
    const res = await app.request(
      `/api/worktrees/${sessionId}/file?path=..%2F..%2Fetc%2Fpasswd&root=${encodeURIComponent(outside)}`,
    );
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
  });

  it('writes under an override (10.4), with the stale-file guard intact', async () => {
    const target = `/api/worktrees/${sessionId}/file?path=notes%2Ftodo.md&root=${encodeURIComponent(outside)}`;
    const res = await app.request(target, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'edited outside\n' }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(outside, 'notes', 'todo.md'), 'utf8')).toBe('edited outside\n');

    const stale = await app.request(target, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x', expected_mtime_ms: 1 }),
    });
    expect(stale.status).toBe(409);
    expect(errorCode(await stale.json())).toBe('stale_file');
  });

  it('uploads under an override (12.3), still confined to it', async () => {
    const form = new FormData();
    form.set('files', new File(['dropped\n'], 'dropped.txt'));
    const res = await app.request(
      `/api/worktrees/${sessionId}/upload?dir=notes&root=${encodeURIComponent(outside)}`,
      { method: 'POST', body: form },
    );
    expect(res.status).toBe(201);
    expect(readFileSync(join(outside, 'notes', 'dropped.txt'), 'utf8')).toBe('dropped\n');
    // …and the worktree is untouched, which is the whole point of the override.
    expect(existsSync(join(worktree, 'notes', 'dropped.txt'))).toBe(false);

    const escape = new FormData();
    escape.set('files', new File(['x'], '../escaped.txt'));
    const contained = await app.request(
      `/api/worktrees/${sessionId}/upload?dir=notes&root=${encodeURIComponent(outside)}`,
      { method: 'POST', body: escape },
    );
    // Per-segment sanitising neutralises `..`, so it lands inside `notes`.
    expect(contained.status).toBe(201);
    expect(existsSync(join(outside, 'notes', 'escaped.txt'))).toBe(true);
    expect(existsSync(join(outside, 'escaped.txt'))).toBe(false);
  });

  it('still rejects an ABSOLUTE path in a mutation body, override or not', async () => {
    // `?root=` is the only way to name another directory; a body path stays
    // relative, so an absolute one is a bug rather than a shortcut.
    const res = await app.request(`/api/worktrees/${sessionId}/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: `${outside}/evil.txt`, kind: 'file' }),
    });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
  });
});

describe('worktree-files: shared error conditions', () => {
  it('404s an unknown session on every endpoint', async () => {
    const uploadForm = new FormData();
    uploadForm.set('a', new File(['x'], 'x.txt'));

    expect((await tree('no-such-session')).status).toBe(404);
    expect((await getFile('no-such-session', 'apple.txt')).status).toBe(404);
    expect((await putFile('no-such-session', 'apple.txt', { content: 'x' })).status).toBe(404);
    expect((await upload('no-such-session', 'uploads', uploadForm)).status).toBe(404);
    expect((await download('no-such-session', 'apple.txt')).status).toBe(404);
  });

  it('409s every endpoint once the worktree is gone from disk', async () => {
    const uploadForm = new FormData();
    uploadForm.set('a', new File(['x'], 'x.txt'));
    // Windows cannot delete a directory that the live agent uses as its cwd.
    if (process.platform === 'win32') await fx.service.kill(sessionId);
    rmSync(worktree, { recursive: true, force: true });
    expect(existsSync(worktree)).toBe(false);

    expect((await tree(sessionId)).status).toBe(409);
    expect((await getFile(sessionId, 'apple.txt')).status).toBe(409);
    expect((await putFile(sessionId, 'apple.txt', { content: 'x' })).status).toBe(409);
    expect((await upload(sessionId, 'uploads', uploadForm)).status).toBe(409);
    expect((await download(sessionId, 'apple.txt')).status).toBe(409);
  });
});
