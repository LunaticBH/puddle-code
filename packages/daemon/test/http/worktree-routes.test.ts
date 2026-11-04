import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  pasteImageResponseSchema,
  resolvePathResponseSchema,
  UNTITLED_SESSION,
} from '@puddle/shared';
import { worktreeRoutes } from '../../src/http/routes/worktrees/worktrees.js';
import { ApiError } from '../../src/http/errors.js';
import { fixture, waitFor, type Fixture } from '../helpers/daemon-fixtures.js';

// A real (tiny) PNG so the round trip is byte-exact.
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

let fx: Fixture;
let sessionId: string;
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

beforeAll(async () => {
  fx = fixture();
  const session = await fx.service.create({
    project_id: fx.ids.project,
    account_id: fx.ids.account,
    title: 'paste target',
  });
  sessionId = session.id;
  await waitFor(() => fx.service.get(sessionId).status !== 'starting');

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

function paste(sid: string, body: unknown) {
  return app.request(`/api/worktrees/${sid}/paste`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/worktrees/:sid/paste', () => {
  it('writes the image into .puddle/pastes/ and returns its relative path', async () => {
    const res = await paste(sessionId, {
      mime: 'image/png',
      data: PNG_BYTES.toString('base64'),
    });
    expect(res.status).toBe(201);
    const { path } = pasteImageResponseSchema.parse(await res.json());
    expect(path).toMatch(/^\.puddle\/pastes\/paste-\d{8}T\d{6}-[0-9a-f]{6}\.png$/);

    const worktree = fx.service.get(sessionId).worktree_path;
    expect(readFileSync(join(worktree, path))).toEqual(PNG_BYTES);
  });

  it('maps each accepted mime to its extension', async () => {
    const res = await paste(sessionId, {
      mime: 'image/jpeg',
      data: PNG_BYTES.toString('base64'),
    });
    const { path } = pasteImageResponseSchema.parse(await res.json());
    expect(path.endsWith('.jpg')).toBe(true);
  });

  it('rejects an unsupported mime', async () => {
    const res = await paste(sessionId, { mime: 'image/tiff', data: 'aGk=' });
    expect(res.status).toBe(400);
  });

  it('rejects data that decodes to nothing', async () => {
    const res = await paste(sessionId, { mime: 'image/png', data: '@@@@' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_image');
  });

  it('404s an unknown session', async () => {
    const res = await paste('no-such-session', { mime: 'image/png', data: 'aGk=' });
    expect(res.status).toBe(404);
  });

  it('409s when the worktree is gone from disk', async () => {
    const worktree = fx.service.get(sessionId).worktree_path;
    // Windows cannot delete a directory that the live agent uses as its cwd.
    if (process.platform === 'win32') await fx.service.kill(sessionId);
    rmSync(worktree, { recursive: true, force: true });
    expect(existsSync(worktree)).toBe(false);
    const res = await paste(sessionId, { mime: 'image/png', data: 'aGk=' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('worktree_missing');
  });
});

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

function resolvePath(sid: string, query: string) {
  return app.request(`/api/worktrees/${sid}/resolve${query}`);
}

describe('GET /api/worktrees/:sid/resolve', () => {
  // Own session (and its own worktree) so the destructive 409 test at the
  // end of this block doesn't collide with the paste block above, which
  // removes ITS session's worktree from disk in its own final test.
  let resolveSessionId: string;
  let worktree: string;

  beforeAll(async () => {
    const session = await fx.service.create({
      project_id: fx.ids.project,
      account_id: fx.ids.account,
      title: 'resolve target',
    });
    resolveSessionId = session.id;
    await waitFor(() => fx.service.get(resolveSessionId).status !== 'starting');
    worktree = fx.service.get(resolveSessionId).worktree_path;
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'foo.ts'), 'export const x = 1;\n');
  });

  afterAll(async () => {
    await fx.service.kill(resolveSessionId).catch(() => undefined);
  });

  it('resolves a relative path hit, echoing the line', async () => {
    const res = await resolvePath(resolveSessionId, '?path=src/foo.ts&line=5');
    expect(res.status).toBe(200);
    const body = resolvePathResponseSchema.parse(await res.json());
    expect(body).toEqual({ path: 'src/foo.ts', line: 5, kind: 'file' });
  });

  it('resolves a ./-prefixed relative path', async () => {
    const res = await resolvePath(resolveSessionId, '?path=./src/foo.ts');
    expect(res.status).toBe(200);
    const body = resolvePathResponseSchema.parse(await res.json());
    expect(body.path).toBe('src/foo.ts');
  });

  it('resolves an absolute path inside the worktree', async () => {
    const abs = join(worktree, 'src', 'foo.ts');
    const res = await resolvePath(resolveSessionId, `?path=${encodeURIComponent(abs)}`);
    expect(res.status).toBe(200);
    const body = resolvePathResponseSchema.parse(await res.json());
    expect(body.path).toBe('src/foo.ts');
  });

  it('resolves an absolute file outside the worktree to external-tab coordinates (15.2)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'puddle-resolve-outside-'));
    writeFileSync(join(outside, 'notes.ts'), 'x');
    const res = await resolvePath(
      resolveSessionId,
      `?path=${encodeURIComponent(join(outside, 'notes.ts'))}&line=3`,
    );
    expect(res.status).toBe(200);
    const body = resolvePathResponseSchema.parse(await res.json());
    expect(body).toEqual({ path: 'notes.ts', root: outside, line: 3, kind: 'file' });
  });

  it('resolves a directory to its absolute path as kind dir (15.2)', async () => {
    const res = await resolvePath(resolveSessionId, '?path=src&line=4');
    expect(res.status).toBe(200);
    const body = resolvePathResponseSchema.parse(await res.json());
    // No line: a directory opens the file tree, there is nothing to scroll to.
    expect(body).toEqual({
      path: join(worktree, 'src'),
      line: null,
      kind: 'dir',
      relative_path: 'src',
    });
  });

  it('resolves a directory outside the worktree too', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'puddle-resolve-outdir-'));
    const res = await resolvePath(resolveSessionId, `?path=${encodeURIComponent(outside)}`);
    expect(res.status).toBe(200);
    const body = resolvePathResponseSchema.parse(await res.json());
    expect(body).toEqual({ path: outside, line: null, kind: 'dir' });
  });

  it('expands ~ against the daemon host home (15.2)', async () => {
    const res = await resolvePath(resolveSessionId, `?path=${encodeURIComponent('~')}`);
    expect(res.status).toBe(200);
    const body = resolvePathResponseSchema.parse(await res.json());
    expect(body).toEqual({ path: homedir(), line: null, kind: 'dir' });
  });

  it.runIf(process.platform === 'win32')(
    'accepts either separator, any case and ~\\ on Windows, answering canonically',
    async () => {
      const lower = join(worktree, 'src').replaceAll('\\', '/').toLowerCase();
      const dir = resolvePathResponseSchema.parse(
        await (await resolvePath(resolveSessionId, `?path=${encodeURIComponent(lower)}`)).json(),
      );
      expect(dir).toEqual({
        path: join(worktree, 'src'),
        line: null,
        kind: 'dir',
        relative_path: 'src',
      });
      const file = resolvePathResponseSchema.parse(
        await (
          await resolvePath(resolveSessionId, `?path=${encodeURIComponent(`${lower}\\foo.ts`)}`)
        ).json(),
      );
      expect(file.path).toBe('src/foo.ts');
      const home = resolvePathResponseSchema.parse(
        await (await resolvePath(resolveSessionId, `?path=${encodeURIComponent('~\\')}`)).json(),
      );
      expect(home).toEqual({ path: homedir(), line: null, kind: 'dir' });
    },
  );

  it.runIf(process.platform === 'win32')(
    'refuses device-namespace and network spellings of a path outside the worktree on Windows',
    async () => {
      const outside = mkdtempSync(join(tmpdir(), 'puddle-resolve-device-'));
      const secret = join(outside, 'secret.ts');
      writeFileSync(secret, 'x');
      const status = async (path: string) =>
        (await resolvePath(resolveSessionId, `?path=${encodeURIComponent(path)}`)).status;
      // The drive spelling resolves; the same file through \\?\ or \\.\ does not.
      expect(await status(secret)).toBe(200);
      for (const prefix of ['\\\\?\\', '\\\\.\\', '//?/']) {
        expect(await status(`${prefix}${secret}`), prefix).toBe(404);
      }
      expect(await status('\\\\puddle-unreachable.invalid\\share\\x.txt')).toBe(404);
    },
  );

  it('resolves relative paths from a session-less directory target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'puddle-resolve-directory-target-'));
    writeFileSync(join(root, 'notes.md'), '# notes\n');
    const query = new URLSearchParams({ root, path: 'notes.md' });
    const res = await resolvePath(UNTITLED_SESSION, `?${query}`);
    expect(res.status).toBe(200);
    expect(resolvePathResponseSchema.parse(await res.json())).toEqual({
      path: 'notes.md',
      line: null,
      kind: 'file',
    });
  });

  it('404s a traversal that resolves to nothing', async () => {
    // `..` is no longer rejected on principle (15.2) — but this resolves to a
    // path that does not exist, and a missing path is still a plain 404.
    const res = await resolvePath(
      resolveSessionId,
      `?path=${encodeURIComponent('../../no-such-dir/passwd')}`,
    );
    expect(res.status).toBe(404);
  });

  // Needs a file symlink, which an unprivileged Windows account cannot create.
  it.skipIf(!fileSymlinks)(
    'resolves a symlink inside the worktree pointing at an outside file',
    async () => {
      const outside = mkdtempSync(join(tmpdir(), 'puddle-resolve-outside-'));
      writeFileSync(join(outside, 'secret.ts'), 'top secret');
      symlinkSync(join(outside, 'secret.ts'), join(worktree, 'escape-link.ts'));

      // Symlinks are followed (read+write policy) — a terminal link to a
      // symlinked-out file opens just like the explorer opens it. Only lexical
      // `..`/absolute escapes 404 (covered above).
      const res = await resolvePath(resolveSessionId, '?path=escape-link.ts');
      expect(res.status).toBe(200);
    },
  );

  it('404s a missing file', async () => {
    const res = await resolvePath(resolveSessionId, '?path=nope.ts');
    expect(res.status).toBe(404);
  });

  it('400s when path is missing', async () => {
    const res = await resolvePath(resolveSessionId, '');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_request');
  });

  it('400s when path is empty', async () => {
    const res = await resolvePath(resolveSessionId, '?path=');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_request');
  });

  it('clamps a zero line to 1', async () => {
    const res = await resolvePath(resolveSessionId, '?path=src/foo.ts&line=0');
    const body = resolvePathResponseSchema.parse(await res.json());
    expect(body.line).toBe(1);
  });

  it('nulls the line when absent', async () => {
    const res = await resolvePath(resolveSessionId, '?path=src/foo.ts');
    const body = resolvePathResponseSchema.parse(await res.json());
    expect(body.line).toBeNull();
  });

  it('nulls the line when it is not a number', async () => {
    const res = await resolvePath(resolveSessionId, '?path=src/foo.ts&line=junk');
    const body = resolvePathResponseSchema.parse(await res.json());
    expect(body.line).toBeNull();
  });

  it('404s an unknown session', async () => {
    const res = await resolvePath('no-such-session', '?path=src/foo.ts');
    expect(res.status).toBe(404);
  });

  it('409s when the worktree is gone from disk', async () => {
    // Windows cannot delete a directory that the live agent uses as its cwd.
    if (process.platform === 'win32') await fx.service.kill(resolveSessionId);
    rmSync(worktree, { recursive: true, force: true });
    expect(existsSync(worktree)).toBe(false);
    const res = await resolvePath(resolveSessionId, '?path=src/foo.ts');
    expect(res.status).toBe(409);
    expect(errorCode(await res.json())).toBe('worktree_missing');
  });
});
