import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import type {
  DiffResponse,
  FileAtResponse,
  FileResponse,
  FsOpResponse,
  GitStatusResponse,
  GitOriginalResponse,
  GitRepositoriesResponse,
  GitMutationResponse,
  GitArea,
  IndexFileResponse,
  LogResponse,
  PutFileRequest,
  PutFileResponse,
  SearchResponse,
  ShowCommitResponse,
  TreeResponse,
  TransferEntryRequest,
  UploadResponse,
} from '@puddle/shared';
import { api, apiFetchRaw } from '../transport/api';
import { focusAwareInterval } from './poll-focus';

/**
 * TanStack Query hooks for a session's worktree: file browsing/editing (the
 * explorer, this task) and git inspection (diff/file-at/log/show, consumed
 * by Tasks 8/9 — defined here now so the API surface is complete). Follows
 * `queries.ts`'s conventions (array keys, `enabled` guards, `api<T>()`) but
 * lives in its own file because `queries.ts` is a concurrent-session hotspot.
 */

const LOG_PAGE_SIZE = 50;

/** `&root=` suffix for the read-only browse override (protocol 10.2), or ''. */
export function rootParam(root: string | undefined): string {
  return root === undefined ? '' : `&root=${encodeURIComponent(root)}`;
}

/**
 * Keep the previous answer on screen while the next one is in flight (decision
 * 2026-08-04). Every one of these queries is keyed by the SESSION, and the whole
 * left sidebar re-binds whenever the focused tab changes — so without this, each
 * switch dropped the file tree, the git decorations, the uncommitted list, and
 * the commit graph back to "Loading…" and rebuilt them, which reads as a blink.
 * It is not merely cosmetic: sessions joining one worktree (puddle's default)
 * ask the same questions of the same directory under different ids, so the
 * "previous" data is usually the very data the new query returns.
 *
 * Only ever applied to an ENABLED query: a disabled one has no request coming to
 * replace the placeholder, so it would sit there showing a directory it is not
 * bound to (the git-status query is disabled under a directory target).
 */
function keepPrevious<T>(enabled: boolean): {
  placeholderData?: (previous: T | undefined) => T | undefined;
} {
  return enabled ? { placeholderData: (previous) => previous } : {};
}

export function useWorktreeTree(sid: string | undefined, path: string, root?: string) {
  const enabled = sid !== undefined;
  return useQuery({
    // The extra key element only when overridden keeps every existing
    // `['wt-tree', sid, …]` invalidation prefix working unchanged.
    queryKey: root === undefined ? ['wt-tree', sid, path] : ['wt-tree', sid, path, root],
    queryFn: () =>
      api<TreeResponse>(
        'GET',
        `/api/worktrees/${sid}/tree?path=${encodeURIComponent(path)}${rootParam(root)}`,
      ),
    enabled,
    ...keepPrevious<TreeResponse>(enabled),
  });
}

export function useWorktreeFile(
  sid: string | undefined,
  path: string,
  opts?: { enabled?: boolean; root?: string; live?: boolean },
) {
  const root = opts?.root;
  return useQuery({
    queryKey: root === undefined ? ['wt-file', sid, path] : ['wt-file', sid, path, root],
    queryFn: () =>
      api<FileResponse>(
        'GET',
        `/api/worktrees/${sid}/file?path=${encodeURIComponent(path)}${rootParam(root)}`,
      ),
    enabled: sid !== undefined && (opts?.enabled ?? true),
    // `live`: keep re-reading the file so a view that only READS it (a rendered
    // preview) tracks what an agent writes, instead of waiting for a window
    // refocus. The daemon has no file-watch to subscribe to, so this is the same
    // focus-aware poll the diff and git-status queries use — and the same reason
    // it stays opt-in: an editor tab has a caret and does not need it, and a poll
    // per open file would be paid for in battery (docs/reports).
    ...(opts?.live === true
      ? { refetchInterval: focusAwareInterval(3_000), refetchOnWindowFocus: true }
      : {}),
  });
}

export function useSaveWorktreeFile(sid: string | undefined, root?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, ...body }: { path: string } & PutFileRequest) =>
      api<PutFileResponse>(
        'PUT',
        `/api/worktrees/${sid}/file?path=${encodeURIComponent(path)}${rootParam(root)}`,
        body,
      ),
    onSuccess: (_res, { path }) => {
      void qc.invalidateQueries({
        queryKey: root === undefined ? ['wt-file', sid, path] : ['wt-file', sid, path, root],
      });
      void qc.invalidateQueries({ queryKey: ['wt-diff', sid] });
    },
  });
}

/**
 * Changed files for a worktree, polled. `against` selects the comparison base:
 * `base` (default) is the merge-base with the session's base branch — the whole
 * of the session's work; `head` is the working tree vs. HEAD — just the
 * uncommitted changes (the Changes navigator's top panel, SPEC §8).
 */
export function useWorktreeDiff(
  sid: string | undefined,
  opts?: { enabled?: boolean; against?: 'base' | 'head'; area?: GitArea; root?: string },
) {
  const against = opts?.against ?? 'base';
  const area = opts?.area;
  const root = opts?.root;
  const enabled = sid !== undefined && (opts?.enabled ?? true);
  return useQuery({
    queryKey:
      root === undefined ? ['wt-diff', sid, against, area] : ['wt-diff', sid, against, area, root],
    queryFn: () => {
      const areaParam = area === undefined ? '' : `&area=${area}`;
      return api<DiffResponse>(
        'GET',
        `/api/worktrees/${sid}/diff?against=${against}${areaParam}${rootParam(root)}`,
      );
    },
    enabled,
    refetchInterval: focusAwareInterval(10_000),
    refetchOnWindowFocus: true,
    ...keepPrevious<DiffResponse>(enabled),
  });
}

/** Repository-aware status/source-control panels (protocol 15.3). */
export function useGitRepositories(
  sid: string | undefined,
  opts?: { enabled?: boolean; root?: string },
) {
  const root = opts?.root;
  const enabled = sid !== undefined && (opts?.enabled ?? true);
  return useQuery({
    queryKey: root === undefined ? ['git-repositories', sid] : ['git-repositories', sid, root],
    queryFn: () =>
      api<GitRepositoriesResponse>('GET', `/api/worktrees/${sid}/git-repositories${opQuery(root)}`),
    enabled,
    refetchInterval: focusAwareInterval(10_000),
    refetchOnWindowFocus: true,
    ...keepPrevious<GitRepositoriesResponse>(enabled),
  });
}

/** The current HEAD baseline for an ordinary source editor (protocol 15.3). */
export function useGitOriginal(
  sid: string | undefined,
  path: string,
  opts?: { enabled?: boolean; root?: string },
) {
  const root = opts?.root;
  const enabled = sid !== undefined && (opts?.enabled ?? true);
  return useQuery({
    queryKey: ['git-original', sid, path, root],
    queryFn: () =>
      api<GitOriginalResponse>(
        'GET',
        `/api/worktrees/${sid}/git-original?path=${encodeURIComponent(path)}${rootParam(root)}`,
      ),
    enabled,
    refetchInterval: focusAwareInterval(10_000),
    refetchOnWindowFocus: true,
  });
}

/** A path exactly as represented in its owning repository's index. */
export function useIndexFile(
  sid: string | undefined,
  path: string,
  opts?: { enabled?: boolean; root?: string },
) {
  const root = opts?.root;
  return useQuery({
    queryKey: ['git-index-file', sid, path, root],
    queryFn: () =>
      api<IndexFileResponse>(
        'GET',
        `/api/worktrees/${sid}/index-file?path=${encodeURIComponent(path)}${rootParam(root)}`,
      ),
    enabled: sid !== undefined && (opts?.enabled ?? true),
  });
}

export type GitMutationVariables =
  | { action: 'stage' | 'unstage'; repository: string; paths: string[] }
  | { action: 'commit'; repository: string; message: string; stage_all?: boolean }
  | { action: 'fetch' | 'pull'; repository: string }
  | { action: 'push'; repository: string; set_upstream?: boolean };

/** Every source-control write shares invalidation and error behaviour. */
export function useGitMutation(sid: string, root?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, ...body }: GitMutationVariables) =>
      api<GitMutationResponse>('POST', `/api/worktrees/${sid}/git-${action}${opQuery(root)}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['git-repositories', sid] });
      void qc.invalidateQueries({ queryKey: ['wt-git-status', sid] });
      void qc.invalidateQueries({ queryKey: ['wt-diff', sid] });
      void qc.invalidateQueries({ queryKey: ['wt-log', sid] });
      void qc.invalidateQueries({ queryKey: ['wt-show', sid] });
      void qc.invalidateQueries({ queryKey: ['git-original', sid] });
      void qc.invalidateQueries({ queryKey: ['git-index-file', sid] });
    },
  });
}

/**
 * Per-path working-tree git status for the file explorer's decorations
 * (SPEC §8), polled like the diff view. Distinct from `useWorktreeDiff`: it
 * carries the full VSCode-grade set (untracked/conflicted/ignored) and is keyed
 * to the whole worktree, so the tree can decorate every row from one map.
 */
export function useWorktreeGitStatus(
  sid: string | undefined,
  opts?: { enabled?: boolean; root?: string },
) {
  const root = opts?.root;
  const enabled = sid !== undefined && (opts?.enabled ?? true);
  return useQuery({
    queryKey: root === undefined ? ['wt-git-status', sid] : ['wt-git-status', sid, root],
    queryFn: () =>
      api<GitStatusResponse>('GET', `/api/worktrees/${sid}/git-status${opQuery(root)}`),
    enabled,
    refetchInterval: focusAwareInterval(10_000),
    refetchOnWindowFocus: true,
    ...keepPrevious<GitStatusResponse>(enabled),
  });
}

/**
 * The four fs mutations. Each takes the same optional `root` the read routes do
 * (protocol 12.3, gated by `MUTATION_ROOT_MINOR` below): with it, every path in
 * the body is relative to that root instead of the worktree, so the browse tree
 * mutates the directory it is actually showing. `?root=` rides the query string
 * rather than the body precisely so these stay one shape with the read routes.
 */
function opQuery(root: string | undefined): string {
  return root === undefined ? '' : `?root=${encodeURIComponent(root)}`;
}

/** Create an empty file or a folder (SPEC §8). */
export function createEntry(sid: string, path: string, kind: 'file' | 'dir', root?: string) {
  return api<FsOpResponse>('POST', `/api/worktrees/${sid}/create${opQuery(root)}`, { path, kind });
}

/** Rename or move an entry — one server-side `fs.rename` (SPEC §8). */
export function renameEntry(sid: string, from: string, to: string, root?: string) {
  return api<FsOpResponse>('POST', `/api/worktrees/${sid}/rename${opQuery(root)}`, { from, to });
}

/** Copy an entry recursively; the server auto-suffixes ` copy` on collision (SPEC §8). */
export function copyEntry(sid: string, from: string, to: string, root?: string) {
  return api<FsOpResponse>('POST', `/api/worktrees/${sid}/copy${opQuery(root)}`, { from, to });
}

/** Copy or move one entry from an independently identified filetree (protocol 16.3). */
export function transferEntry(sid: string, body: TransferEntryRequest, root?: string) {
  return api<FsOpResponse>('POST', `/api/worktrees/${sid}/transfer${opQuery(root)}`, body);
}

/** Delete an entry recursively — irreversible, no host trash (SPEC §8). */
export function deleteEntry(sid: string, path: string, root?: string) {
  return api<FsOpResponse>('POST', `/api/worktrees/${sid}/delete${opQuery(root)}`, { path });
}

export interface SearchParams {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/**
 * Filename + content search for a worktree (SPEC §8, Search navigator). Only
 * runs once `query` is non-empty; `staleTime` is short because worktree files
 * change under a running agent. The flags key the cache so toggling one
 * refetches without clobbering the previous result.
 */
export function useWorktreeSearch(sid: string | undefined, params: SearchParams, root?: string) {
  const { query, regex, caseSensitive, wholeWord } = params;
  return useQuery({
    queryKey: ['wt-search', sid, query, regex, caseSensitive, wholeWord, root],
    queryFn: () => {
      const qs = new URLSearchParams({ q: query });
      if (regex) qs.set('regex', '1');
      if (caseSensitive) qs.set('case', '1');
      if (wholeWord) qs.set('word', '1');
      if (root !== undefined) qs.set('root', root);
      return api<SearchResponse>('GET', `/api/worktrees/${sid}/search?${qs.toString()}`);
    },
    enabled: sid !== undefined && query.length > 0,
    staleTime: 2_000,
  });
}

/**
 * `staleTime: Infinity` assumes `ref` is either a commit sha or a resolved,
 * stable base (the sha `diff`'s `against` reports, not a moving branch name
 * like `origin/main`) — content at a fixed commit never changes, so this
 * only ever needs fetching once per (sid, ref, path).
 */
export function useFileAt(
  sid: string | undefined,
  ref: string,
  path: string,
  opts?: { enabled?: boolean; root?: string },
) {
  const root = opts?.root;
  return useQuery({
    queryKey: ['wt-file-at', sid, ref, path, root],
    queryFn: () =>
      api<FileAtResponse>(
        'GET',
        `/api/worktrees/${sid}/file-at?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}${rootParam(root)}`,
      ),
    enabled: sid !== undefined && (opts?.enabled ?? true),
    staleTime: Infinity,
  });
}

export function useWorktreeLog(
  sid: string | undefined,
  opts?: { enabled?: boolean; root?: string },
) {
  const root = opts?.root;
  const enabled = sid !== undefined && (opts?.enabled ?? true);
  return useInfiniteQuery({
    queryKey: root === undefined ? ['wt-log', sid] : ['wt-log', sid, root],
    queryFn: ({ pageParam }) =>
      api<LogResponse>(
        'GET',
        `/api/worktrees/${sid}/log?limit=${LOG_PAGE_SIZE}&skip=${pageParam}${rootParam(root)}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.has_more ? pages.length * LOG_PAGE_SIZE : undefined,
    enabled,
    // The graph keeps the commits it is showing while the next worktree's land
    // (see `keepPrevious`); pages carried over are replaced wholesale by the
    // first page of the new query, never appended to.
    ...keepPrevious<InfiniteData<LogResponse, number>>(enabled),
  });
}

export function useCommitShow(sid: string | undefined, sha: string | undefined, root?: string) {
  return useQuery({
    queryKey: root === undefined ? ['wt-show', sid, sha] : ['wt-show', sid, sha, root],
    queryFn: () =>
      api<ShowCommitResponse>('GET', `/api/worktrees/${sid}/show/${sha}${opQuery(root)}`),
    enabled: sid !== undefined && sha !== undefined,
    staleTime: Infinity,
  });
}

/**
 * Target batch size for multipart uploads: a folder drop can be arbitrarily
 * large, so files are grouped greedily into requests of roughly this size
 * (well under the daemon's 512 MiB per-request cap, which then only binds on
 * a single enormous file).
 */
const UPLOAD_BATCH_BYTES = 64 * 1024 * 1024;

/** Greedy split preserving order; every batch has ≥1 file. */
export function batchBySize(files: File[], limit: number): File[][] {
  const batches: File[][] = [];
  let batch: File[] = [];
  let size = 0;
  for (const file of files) {
    if (batch.length > 0 && size + file.size > limit) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(file);
    size += file.size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** Drag-in / paste upload into a worktree (or browse-`root`) directory (SPEC §8), batched. */
export async function uploadFiles(
  sid: string,
  dir: string,
  files: File[],
  root?: string,
): Promise<UploadResponse> {
  const uploaded: UploadResponse['files'] = [];
  for (const batch of batchBySize(files, UPLOAD_BATCH_BYTES)) {
    const form = new FormData();
    for (const file of batch) form.append('files', file, file.name);
    const res = await apiFetchRaw(
      'POST',
      `/api/worktrees/${sid}/upload?dir=${encodeURIComponent(dir)}${rootParam(root)}`,
      { body: form },
    );
    uploaded.push(...((await res.json()) as UploadResponse).files);
  }
  return { files: uploaded };
}

/**
 * Picks the download's filename from the daemon's `content-disposition`
 * header (`worktree-files.ts`'s `contentDisposition`, which always sends the
 * RFC 5987 `filename*=UTF-8''…` form) with a plain `filename=…` fallback for
 * any other server, and `fallback` (the requested path's basename) when the
 * header is missing entirely. Pure so it's testable without a DOM.
 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const starred = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (starred?.[1]) {
    try {
      return decodeURIComponent(starred[1]);
    } catch {
      return fallback;
    }
  }
  const plain = /filename="?([^"; ]+)"?/i.exec(header);
  return plain?.[1] ?? fallback;
}

/** Downloads a worktree path (file, or zipped directory) to the browser's Downloads (SPEC §8). */
export async function downloadPath(sid: string, path: string, root?: string): Promise<void> {
  const res = await apiFetchRaw(
    'GET',
    `/api/worktrees/${sid}/download?path=${encodeURIComponent(path)}${rootParam(root)}`,
  );
  const blob = await res.blob();
  const fallback = path.split('/').filter(Boolean).pop() ?? 'worktree';
  const filename = filenameFromDisposition(res.headers.get('content-disposition'), fallback);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
