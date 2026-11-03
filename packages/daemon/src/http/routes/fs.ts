import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, win32 } from 'node:path';
import { Hono } from 'hono';
import type { FsDirsResponse } from '@puddle/shared';
import { canonicalHostPath, isNativeAbsolute, rootBareDrive } from '../../host-path.js';
import { ApiError } from '../errors.js';
import { expandTilde } from '../tilde.js';

const MAX_ENTRIES = 50;

/**
 * Where a typed prefix lists from, and the partial name it completes. "/a/b/par"
 * completes "par" inside /a/b; a trailing slash lists everything. Windows
 * accepts either separator, reads a bare `C:` as the drive root (browsing stops
 * there: drives are not enumerated), and lists from the canonical parent so the
 * returned paths are canonical too.
 */
export function dirsQuery(
  prefix: string,
  platform: NodeJS.Platform = process.platform,
): { parent: string; partial: string } {
  if (platform !== 'win32') {
    if (!isAbsolute(prefix)) throw invalidPrefix();
    return {
      parent: prefix.endsWith('/') ? prefix : dirname(prefix),
      partial: prefix.endsWith('/') ? '' : basename(prefix).toLowerCase(),
    };
  }
  const path = rootBareDrive(prefix, platform);
  if (!isNativeAbsolute(path, platform)) throw invalidPrefix();
  const listsDirectory = /[\\/]$/.test(path);
  return {
    parent: canonicalHostPath(listsDirectory ? path : win32.dirname(path), platform),
    partial: listsDirectory ? '' : win32.basename(path).toLowerCase(),
  };
}

function invalidPrefix(): ApiError {
  return ApiError.badRequest(
    'invalid_prefix',
    `'prefix' must be an absolute path (a leading ~ is expanded on the host)`,
  );
}

/**
 * Directory autocomplete for repo registration (SPEC §6). Trusted single-user
 * box: the token holder can already spawn agents, so listing directories
 * grants nothing new. Directories only; dotdirs included.
 */
export function fsRoutes(): Hono {
  return new Hono().get('/dirs', (c) => {
    const { parent, partial } = dirsQuery(expandTilde(c.req.query('prefix') ?? ''));

    let names: string[];
    try {
      names = readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name);
    } catch {
      return c.json<FsDirsResponse>({ entries: [] }); // unreadable parent → no hints
    }

    const entries = names
      .filter((name) => name.toLowerCase().startsWith(partial))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_ENTRIES)
      .map((name) => {
        const path = join(parent, name);
        return { path, name, is_git: existsSync(join(path, '.git')) };
      });
    return c.json<FsDirsResponse>({ entries });
  });
}
