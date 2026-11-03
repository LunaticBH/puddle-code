import type { IBufferCellPosition, IDisposable, ILink, Terminal as XTerm } from '@xterm/xterm';
import type { HostPathStyle, ResolvePathResponse } from '@puddle/shared';
import { api } from '../../../lib/transport/api';
import { findBufferPathCandidates } from './file-link-buffer';
export { findBufferPathCandidates } from './file-link-buffer';
export { findPathCandidates, type PathCandidate } from './file-link-paths';

/**
 * Validated file-path links for session terminals (SPEC §7). xterm's built-in
 * links handle OSC 8 targets (plain URLs use our URL provider); this provider
 * underlines paths an agent prints — `src/foo.ts:12:3`, `./a/b.py`,
 * `/wt/main.c`, `~/notes/todo.md` — but ONLY after the daemon confirms the
 * target exists, so prose that merely looks path-shaped never lights up.
 * Cmd/Ctrl+click opens a file in the Monaco editor at the given position — as
 * an `external` tab when it lies outside the worktree (15.2) — and a
 * DIRECTORY in the file tree, as a pinned browse rooted there (SPEC §8). A
 * plain click keeps terminal selection.
 *
 * Kept out of `Terminal.tsx` for the same reason as `paste-image.ts`: terminal
 * integrations are separate modules, not inline mount-effect noise. Never
 * registered for `login-*` streams — those have no worktree to resolve against.
 */

/** What a validated link opens: an editor tab, or (for a dir) the browse tree. */
export interface FileLinkTarget {
  kind: 'file' | 'dir';
  /**
   * Worktree-relative for a worktree file; relative to `root` for an outside
   * file; for a `dir`, the ABSOLUTE directory to root the file tree at.
   */
  path: string;
  /** Resolution-root-relative identity when this directory is already in Files. */
  relativePath?: string;
  /** Absolute browse root of a file outside the worktree (an `external` tab). */
  root?: string;
  line?: number;
  column?: number;
}

/**
 * An outside file makes its containing browse root the sidebar's location.
 * A file already rooted at the current directory needs no redundant browse.
 */
export function externalBrowseRoot(target: FileLinkTarget, currentRoot?: string): string | null {
  return target.kind === 'file' && target.root !== undefined && target.root !== currentRoot
    ? target.root
    : null;
}

type Fetcher = (
  sessionId: string,
  path: string,
  line?: number,
) => Promise<ResolvePathResponse | null>;

export interface ResolveCacheOptions {
  fetcher: Fetcher;
  now?: () => number;
  /** How long a 200 stays trusted (default 15s). */
  positiveTtlMs?: number;
  /** How long a 404 stays trusted — short, agents create files mid-session (default 5s). */
  negativeTtlMs?: number;
  /** Oldest-first eviction cap (default 500). */
  maxEntries?: number;
  /** Ceiling on simultaneous in-flight fetches (default 4). */
  maxConcurrent?: number;
}

interface CacheEntry {
  value: ResolvePathResponse | null;
  expiresAt: number;
}

/**
 * Caches `/resolve` answers so hovering a wall of paths cannot hammer the
 * daemon: positive/negative TTLs, in-flight de-duplication, an oldest-first cap,
 * and a concurrency semaphore. Keyed on `(sessionId, path)` — the requested
 * line does not change whether the file exists, so it is not part of the key.
 * The clock and fetcher are injected so the whole thing is unit-testable.
 */
export class ResolveCache {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxConcurrent: number;

  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ResolvePathResponse | null>>();
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(opts: ResolveCacheOptions) {
    this.fetcher = opts.fetcher;
    this.now = opts.now ?? Date.now;
    this.positiveTtlMs = opts.positiveTtlMs ?? 15_000;
    this.negativeTtlMs = opts.negativeTtlMs ?? 5_000;
    this.maxEntries = opts.maxEntries ?? 500;
    this.maxConcurrent = opts.maxConcurrent ?? 4;
  }

  resolve(sessionId: string, path: string, line?: number): Promise<ResolvePathResponse | null> {
    const key = `${sessionId}\0${path}`;

    const entry = this.entries.get(key);
    if (entry) {
      if (this.now() < entry.expiresAt) return Promise.resolve(entry.value);
      this.entries.delete(key); // expired
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = this.withSlot(() => this.fetcher(sessionId, path, line))
      .then((value) => {
        this.store(key, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  private store(key: string, value: ResolvePathResponse | null): void {
    const ttl = value ? this.positiveTtlMs : this.negativeTtlMs;
    this.entries.set(key, { value, expiresAt: this.now() + ttl });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value; // insertion order
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Runs `fn` under the concurrency ceiling, releasing the slot when it settles. */
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inUse >= this.maxConcurrent) {
      await new Promise<void>((release) => this.waiters.push(release));
    }
    this.inUse++;
    try {
      return await fn();
    } finally {
      this.inUse--;
      this.waiters.shift()?.();
    }
  }
}

/** Ask the daemon to resolve one host path against a worktree/directory target. */
async function requestResolvedPath(
  sessionId: string,
  path: string,
  line?: number,
  root?: string,
): Promise<ResolvePathResponse> {
  const query = new URLSearchParams({ path });
  if (line !== undefined) query.set('line', String(line));
  if (root !== undefined) query.set('root', root);
  return api<ResolvePathResponse>('GET', `/api/worktrees/${sessionId}/resolve?${query}`);
}

/** Convert the daemon's normalised identity into the workspace's open target. */
export function fileLinkTarget(
  resolved: ResolvePathResponse,
  line?: number,
  column?: number,
): FileLinkTarget {
  const kind = resolved.kind ?? 'file'; // pre-15.2 daemons only answer files
  return {
    kind,
    path: resolved.path,
    ...(resolved.root !== undefined ? { root: resolved.root } : {}),
    ...(resolved.relative_path !== undefined ? { relativePath: resolved.relative_path } : {}),
    // A directory opens the file tree — a position has nothing to scroll to.
    ...(kind === 'file' && line !== undefined ? { line: Math.max(1, line) } : {}),
    ...(kind === 'file' && column !== undefined ? { column } : {}),
  };
}

/** Resolve a user-entered path through the same path used by terminal links. */
export async function resolveFileLinkTarget(
  sessionId: string,
  path: string,
  opts?: { root?: string; line?: number; column?: number },
): Promise<FileLinkTarget> {
  const resolved = await requestResolvedPath(sessionId, path, opts?.line, opts?.root);
  return fileLinkTarget(resolved, opts?.line, opts?.column);
}

/** The terminal fetcher: errors mean the candidate should not become a link. */
async function resolvePath(
  sessionId: string,
  path: string,
  line?: number,
): Promise<ResolvePathResponse | null> {
  try {
    return await requestResolvedPath(sessionId, path, line);
  } catch {
    // Missing paths and transient errors both mean "don't underline". Fail
    // safe rather than surfacing terminal-hover errors to the user.
    return null;
  }
}

/**
 * Registers the validated file-path link provider on `xterm`. `onOpen` receives
 * the daemon's normalised target (never the raw match) plus the requested
 * line/column. `hostStyle` is read on every lookup, so Windows path patterns
 * apply as soon as `/api/host` reports a win32 host. Returns an `IDisposable`
 * to unregister on unmount.
 */
export function registerFileLinks(
  xterm: XTerm,
  sessionId: string,
  onOpen: (target: FileLinkTarget) => void,
  hostStyle: () => HostPathStyle = () => 'posix',
): IDisposable {
  const cache = new ResolveCache({ fetcher: resolvePath });

  return xterm.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buffer = xterm.buffer.active;
      // xterm hands provideLinks a 1-based buffer line; map from 0-based.
      const candidates = findBufferPathCandidates(
        buffer,
        bufferLineNumber - 1,
        xterm.cols,
        hostStyle(),
      );
      if (candidates.length === 0) {
        callback(undefined);
        return;
      }

      void Promise.all(
        candidates.map(async ({ candidate, start, end, text }): Promise<ILink | null> => {
          const resolved = await cache.resolve(sessionId, candidate.path, candidate.line);
          if (!resolved) return null;
          return {
            // Buffer positions are 1-based and both ends are inclusive.
            range: {
              start: { x: start.col + 1, y: start.row + 1 },
              end: { x: end.col + 1, y: end.row + 1 },
            } satisfies { start: IBufferCellPosition; end: IBufferCellPosition },
            text,
            decorations: { underline: true, pointerCursor: true },
            activate: (event) => {
              // SPEC §14 activation gesture is cmd/ctrl+click; a plain click
              // must keep the terminal's own text selection.
              if (!event.metaKey && !event.ctrlKey) return;
              onOpen(fileLinkTarget(resolved, candidate.line, candidate.column));
            },
          };
        }),
      ).then((links) => {
        const valid = links.filter((link): link is ILink => link !== null);
        callback(valid.length > 0 ? valid : undefined);
      });
    },
  });
}
