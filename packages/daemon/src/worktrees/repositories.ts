import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type {
  GitChangeEntry,
  GitOriginalResponse,
  GitRepositoriesResponse,
  GitRepository,
  GitStatus,
  GitStatusEntry,
  IndexFileResponse,
} from '@puddle/shared';
import { git, gitBuffer } from '../git/exec.js';
import { gitMutexKey, KeyedMutex } from '../git/mutex.js';
import { ApiError } from '../http/errors.js';

const SNIFF_BYTES = 8 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const mutationMutex = new KeyedMutex();

export type RepositoryLock = <T>(repoRoot: string, run: () => Promise<T>) => Promise<T>;

interface PorcelainEntry {
  path: string;
  oldPath: string | null;
  x: string;
  y: string;
  conflict: boolean;
  ignored: boolean;
  untracked: boolean;
}

export interface PorcelainV2Status {
  head: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: PorcelainEntry[];
}

interface DiscoveredRepository {
  root: string;
  owning: boolean;
  submodule: boolean;
  initialised: boolean;
}

/** Convert host paths to the slash-separated form Git and the wire use. */
function gitPath(path: string): string {
  return path.split(sep).join('/');
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return normalize(resolve(path));
  }
}

async function gitRootAt(path: string): Promise<string | null> {
  try {
    return await canonical(await git(['rev-parse', '--show-toplevel'], { cwd: path }));
  } catch {
    return null;
  }
}

/** Find every initialised nested repository without following symlinked trees. */
async function scanGitRoots(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === '.git')) {
      found.push(await canonical(dir));
      // Git itself can enumerate ignored/untracked child roots much more
      // cheaply; do not descend through a repository's dependency trees here.
      return;
    }
    // Sequential recursion avoids exhausting the process's fd limit on a
    // parent directory containing many large projects.
    for (const entry of entries) {
      if (entry.name !== '.git' && entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(join(dir, entry.name));
      }
    }
  }
  await walk(root);
  return found;
}

/**
 * An owning repo already has a cheap index of interesting untracked/ignored
 * directories. Test those directory roots for a nested `.git` rather than
 * walking dependency trees on every ten-second status refresh.
 */
async function nestedGitRoots(repoRoot: string, visibleRoot: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await git(
      ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=normal'],
      { cwd: repoRoot },
    );
  } catch {
    return [];
  }
  const found: string[] = [];
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i];
    if (!record || record.length < 4) continue;
    const x = record[0];
    const y = record[1];
    const path = record.slice(3).replace(/\/$/, '');
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++;
    const candidate = await canonical(resolve(repoRoot, path));
    if (!isWithin(visibleRoot, candidate)) continue;
    try {
      if (!(await stat(candidate)).isDirectory()) continue;
    } catch {
      continue;
    }
    const actual = await gitRootAt(candidate);
    if (actual === candidate) found.push(candidate);
  }
  return found;
}

interface SubmodulePath {
  root: string;
  initialised: boolean;
}

/** `git submodule status --recursive` includes both initialised and `-` entries. */
async function submodules(repoRoot: string): Promise<SubmodulePath[]> {
  let raw: string;
  try {
    raw = await git(['submodule', 'status', '--recursive'], { cwd: repoRoot });
  } catch {
    return [];
  }
  const out: SubmodulePath[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const match = /^([-+ U])?[0-9a-f]+\s+(.+?)(?:\s+\([^)]*\))?$/.exec(line);
    if (!match?.[2]) continue;
    out.push({
      root: await canonical(resolve(repoRoot, match[2])),
      initialised: match[1] !== '-',
    });
  }
  return out;
}

/**
 * Repositories relevant to a visible directory: its deepest owner first,
 * every nested `.git` worktree (including ignored repos), then recursive
 * submodules that have not yet been initialised.
 */
export async function discoverRepositories(visibleRoot: string): Promise<DiscoveredRepository[]> {
  const visible = await canonical(visibleRoot);
  const owner = await gitRootAt(visible);
  const roots = new Map<string, DiscoveredRepository>();
  if (owner) {
    roots.set(owner, { root: owner, owning: true, submodule: false, initialised: true });
  }
  const scanned = owner ? await nestedGitRoots(owner, visible) : await scanGitRoots(visible);
  for (const root of scanned) {
    const actual = await gitRootAt(root);
    if (!actual || actual !== root) continue;
    roots.set(root, {
      root,
      owning: root === owner,
      submodule: roots.get(root)?.submodule ?? false,
      initialised: true,
    });
  }

  // Expand from every repo found above. Git's status supplies ignored/untracked
  // nested repository roots without a filesystem walk, and recursive
  // submodule status supplies both unusual gitdir layouts and uninitialised
  // entries. Newly added standalone repositories join the queue in turn.
  const queue = [...roots.values()].filter((repo) => repo.initialised);
  const processed = new Set<string>();
  while (queue.length > 0) {
    const repo = queue.shift()!;
    if (processed.has(repo.root)) continue;
    processed.add(repo.root);
    for (const nested of await nestedGitRoots(repo.root, visible)) {
      if (roots.has(nested)) continue;
      const discovered = {
        root: nested,
        owning: nested === owner,
        submodule: false,
        initialised: true,
      };
      roots.set(nested, discovered);
      queue.push(discovered);
    }
    for (const submodule of await submodules(repo.root)) {
      if (!isWithin(visible, submodule.root) && !isWithin(submodule.root, visible)) continue;
      const existing = roots.get(submodule.root);
      const discovered = {
        root: submodule.root,
        owning: existing?.owning ?? submodule.root === owner,
        submodule: true,
        initialised: existing?.initialised ?? submodule.initialised,
      };
      roots.set(submodule.root, discovered);
      if (discovered.initialised) queue.push(discovered);
    }
  }

  return [...roots.values()].sort((a, b) => {
    if (a.owning !== b.owning) return a.owning ? -1 : 1;
    const depthA = a.root.split(sep).length;
    const depthB = b.root.split(sep).length;
    return depthA - depthB || a.root.localeCompare(b.root);
  });
}

function statusForColumn(column: string): Exclude<GitStatus, 'ignored'> {
  switch (column) {
    case '?':
      return 'untracked';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

function combinedStatus(entry: PorcelainEntry): GitStatus {
  if (entry.ignored) return 'ignored';
  if (entry.conflict) return 'conflicted';
  if (entry.untracked) return 'untracked';
  const columns = `${entry.x}${entry.y}`;
  if (columns.includes('A')) return 'added';
  if (columns.includes('R') || columns.includes('C')) return 'renamed';
  if (columns.includes('M') || columns.includes('T')) return 'modified';
  if (columns.includes('D')) return 'deleted';
  return 'modified';
}

function parseHeader(line: string, status: PorcelainV2Status): void {
  if (line.startsWith('# branch.oid ')) {
    const oid = line.slice('# branch.oid '.length);
    status.head = oid === '(initial)' ? null : oid;
  } else if (line.startsWith('# branch.head ')) {
    const head = line.slice('# branch.head '.length);
    status.detached = head === '(detached)';
    status.branch = status.detached ? null : head;
  } else if (line.startsWith('# branch.upstream ')) {
    status.upstream = line.slice('# branch.upstream '.length);
  } else if (line.startsWith('# branch.ab ')) {
    const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
    if (match) {
      status.ahead = Number(match[1]);
      status.behind = Number(match[2]);
    }
  }
}

/** Pure porcelain-v2 `-z --branch` parser, including rename origin tokens. */
export function parsePorcelainV2(raw: string): PorcelainV2Status {
  const status: PorcelainV2Status = {
    head: null,
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [],
  };
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    let record = tokens[i] ?? '';
    // Git versions which retain newline-terminated headers under `-z` place
    // all headers before the first NUL record. Consume only the leading header
    // lines so a newline inside a literal filename remains untouched.
    while (record.startsWith('# ')) {
      const newline = record.indexOf('\n');
      if (newline < 0) {
        parseHeader(record, status);
        record = '';
        break;
      }
      parseHeader(record.slice(0, newline), status);
      record = record.slice(newline + 1);
    }
    if (!record) continue;

    if (record.startsWith('? ') || record.startsWith('! ')) {
      const marker = record[0]!;
      status.entries.push({
        path: record.slice(2),
        oldPath: null,
        x: marker,
        y: marker,
        conflict: false,
        ignored: marker === '!',
        untracked: marker === '?',
      });
      continue;
    }

    const ordinary = /^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(record);
    if (ordinary?.[1] !== undefined && ordinary[2] !== undefined) {
      status.entries.push({
        path: ordinary[2],
        oldPath: null,
        x: ordinary[1][0] ?? '.',
        y: ordinary[1][1] ?? '.',
        conflict: false,
        ignored: false,
        untracked: false,
      });
      continue;
    }

    const renamed = /^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(record);
    if (renamed?.[1] !== undefined && renamed[2] !== undefined) {
      status.entries.push({
        path: renamed[2],
        oldPath: tokens[++i] ?? null,
        x: renamed[1][0] ?? '.',
        y: renamed[1][1] ?? '.',
        conflict: false,
        ignored: false,
        untracked: false,
      });
      continue;
    }

    const unmerged = /^u (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(record);
    if (unmerged?.[1] !== undefined && unmerged[2] !== undefined) {
      status.entries.push({
        path: unmerged[2],
        oldPath: null,
        x: unmerged[1][0] ?? 'U',
        y: unmerged[1][1] ?? 'U',
        conflict: true,
        ignored: false,
        untracked: false,
      });
    }
  }
  return status;
}

async function repositoryStatus(root: string): Promise<PorcelainV2Status> {
  const raw = await git(
    [
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      '--ignored=matching',
      '--untracked-files=all',
      '--renames',
    ],
    { cwd: root },
  );
  return parsePorcelainV2(raw);
}

function groupedEntry(entry: PorcelainEntry, column: string): GitChangeEntry {
  return {
    path: entry.path,
    status: entry.conflict ? 'conflicted' : statusForColumn(column),
    old_path: entry.oldPath,
  };
}

async function describeRepository(
  visible: string,
  discovered: DiscoveredRepository,
): Promise<{ repository: GitRepository; status: PorcelainV2Status | null }> {
  const relativePath = gitPath(relative(visible, discovered.root)) || '.';
  if (!discovered.initialised) {
    return {
      status: null,
      repository: {
        root: discovered.root,
        relative_path: relativePath,
        name: basename(discovered.root),
        owning: discovered.owning,
        submodule: discovered.submodule,
        initialised: false,
        head: null,
        branch: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        has_remote: false,
        staged: [],
        unstaged: [],
        conflicts: [],
      },
    };
  }

  const status = await repositoryStatus(discovered.root);
  const remotes = await git(['remote'], { cwd: discovered.root });
  const staged: GitChangeEntry[] = [];
  const unstaged: GitChangeEntry[] = [];
  const conflicts: GitChangeEntry[] = [];
  for (const entry of status.entries) {
    if (entry.ignored) continue;
    if (entry.conflict) {
      conflicts.push(groupedEntry(entry, 'U'));
      continue;
    }
    if (entry.untracked) {
      unstaged.push(groupedEntry(entry, '?'));
      continue;
    }
    if (entry.x !== '.') staged.push(groupedEntry(entry, entry.x));
    if (entry.y !== '.') unstaged.push(groupedEntry(entry, entry.y));
  }
  return {
    status,
    repository: {
      root: discovered.root,
      relative_path: relativePath,
      name: basename(discovered.root),
      owning: discovered.owning,
      submodule: discovered.submodule,
      initialised: true,
      head: status.head,
      branch: status.branch,
      detached: status.detached,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      has_remote: remotes.length > 0,
      staged,
      unstaged,
      conflicts,
    },
  };
}

/** Repository panels plus a merged, visible-root-relative explorer status. */
export async function gitRepositories(visibleRoot: string): Promise<GitRepositoriesResponse> {
  const visible = await canonical(visibleRoot);
  const discovered = await discoverRepositories(visible);
  const described = [];
  for (const repo of discovered) described.push(await describeRepository(visible, repo));

  const decorations = new Map<string, GitStatus>();
  for (const item of described) {
    const repo = item.repository;
    const nestedRoot = gitPath(relative(visible, repo.root));
    // A child repository is not ignored merely because its parent repository
    // ignores the directory. Keep a genuine parent gitlink modification.
    if (nestedRoot && !nestedRoot.startsWith('..')) {
      for (const [path, value] of decorations) {
        if (value === 'ignored' && (path === nestedRoot || path.startsWith(`${nestedRoot}/`))) {
          decorations.delete(path);
        }
      }
    }
    if (!item.status) continue;
    for (const entry of item.status.entries) {
      const absolute = resolve(repo.root, entry.path);
      if (!isWithin(visible, absolute)) continue;
      const path = gitPath(relative(visible, absolute));
      decorations.set(path, combinedStatus(entry));
    }
  }

  const entries: GitStatusEntry[] = [...decorations].map(([path, status]) => ({ path, status }));
  return { repositories: described.map((item) => item.repository), entries };
}

/** Resolve a requested absolute repository against the freshly discovered set. */
async function requestedRepository(visibleRoot: string, requested: string): Promise<string> {
  if (!isAbsolute(requested)) {
    throw ApiError.badRequest('invalid_repository', `'repository' must be an absolute path`);
  }
  const wanted = await canonical(requested);
  const found = (await discoverRepositories(visibleRoot)).find((repo) => repo.root === wanted);
  if (!found) throw ApiError.badRequest('invalid_repository', `repository is outside this target`);
  if (!found.initialised) {
    throw ApiError.conflict('submodule_uninitialised', `submodule is not initialised`);
  }
  return found.root;
}

/** Validate confinement but return the path byte-for-byte for literal pathspecs. */
function literalPaths(repoRoot: string, paths: readonly string[]): string[] {
  for (const path of paths) {
    if (isAbsolute(path) || !isWithin(repoRoot, resolve(repoRoot, path))) {
      throw ApiError.badRequest('path_outside_repository', `'${path}' escapes the repository`);
    }
  }
  return [...paths];
}

async function underRepositoryLock<T>(
  repoRoot: string,
  fn: () => Promise<T>,
  lock?: RepositoryLock,
): Promise<T> {
  if (lock) return lock(repoRoot, fn);
  return mutationMutex.run(await gitMutexKey(repoRoot), fn);
}

export async function stagePaths(
  visibleRoot: string,
  repository: string,
  paths: readonly string[],
  lock?: RepositoryLock,
): Promise<void> {
  const root = await requestedRepository(visibleRoot, repository);
  const literal = literalPaths(root, paths);
  await underRepositoryLock(
    root,
    () => withPathspecs(root, ['--literal-pathspecs', 'add', '-A'], literal).then(() => undefined),
    lock,
  );
}

/**
 * Runs a git command over literal pathspecs. Windows passes them on stdin
 * (`--pathspec-from-file=- --pathspec-file-nul`, Git 2.26+): a Windows command
 * line holds at most 32,767 characters, which a few hundred deep paths exceed.
 * POSIX keeps them in argv after `--`.
 */
export function withPathspecs(
  cwd: string,
  args: string[],
  paths: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform !== 'win32') return git([...args, '--', ...paths], { cwd });
  return git([...args, '--pathspec-from-file=-', '--pathspec-file-nul'], {
    cwd,
    input: paths.join('\0'),
  });
}

export async function unstagePaths(
  visibleRoot: string,
  repository: string,
  paths: readonly string[],
  lock?: RepositoryLock,
): Promise<void> {
  const root = await requestedRepository(visibleRoot, repository);
  const literal = literalPaths(root, paths);
  await underRepositoryLock(
    root,
    async () => {
      const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root }).catch(
        () => null,
      );
      if (head) {
        await withPathspecs(root, ['--literal-pathspecs', 'reset', '-q', 'HEAD'], literal);
      } else {
        await withPathspecs(root, ['--literal-pathspecs', 'rm', '--cached', '-r', '-q'], literal);
      }
    },
    lock,
  );
}

export async function commitRepository(
  visibleRoot: string,
  repository: string,
  message: string,
  stageAll: boolean,
  lock?: RepositoryLock,
): Promise<string> {
  const root = await requestedRepository(visibleRoot, repository);
  return underRepositoryLock(
    root,
    async () => {
      if (stageAll) await git(['add', '-A', '--'], { cwd: root });
      const status = await repositoryStatus(root);
      if (!status.entries.some((entry) => entry.conflict || entry.x !== '.')) {
        throw ApiError.conflict('no_staged_changes', `there are no staged changes to commit`);
      }
      // Windows reads the message from stdin, clear of the command-line limit.
      if (process.platform === 'win32') {
        await git(['commit', '-F', '-'], { cwd: root, input: message });
      } else {
        await git(['commit', '-m', message], { cwd: root });
      }
      return git(['rev-parse', 'HEAD'], { cwd: root });
    },
    lock,
  );
}

export async function fetchRepository(
  visibleRoot: string,
  repository: string,
  lock?: RepositoryLock,
): Promise<void> {
  const root = await requestedRepository(visibleRoot, repository);
  await underRepositoryLock(
    root,
    () => git(['fetch', '--prune'], { cwd: root }).then(() => undefined),
    lock,
  );
}

export async function pullRepository(
  visibleRoot: string,
  repository: string,
  lock?: RepositoryLock,
): Promise<void> {
  const root = await requestedRepository(visibleRoot, repository);
  await underRepositoryLock(
    root,
    () => git(['pull', '--ff-only'], { cwd: root }).then(() => undefined),
    lock,
  );
}

export async function pushRepository(
  visibleRoot: string,
  repository: string,
  setUpstream: boolean,
  lock?: RepositoryLock,
): Promise<void> {
  const root = await requestedRepository(visibleRoot, repository);
  await underRepositoryLock(
    root,
    async () => {
      if (setUpstream) {
        const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root });
        const remotes = (await git(['remote'], { cwd: root })).split('\n').filter(Boolean);
        const remote = remotes.includes('origin') ? 'origin' : remotes[0];
        if (!remote) throw ApiError.conflict('no_remote', `repository has no remote to publish to`);
        await git(['push', '--set-upstream', remote, branch], { cwd: root });
      } else {
        await git(['push'], { cwd: root });
      }
    },
    lock,
  );
}

async function ownerForPath(visibleRoot: string, absolutePath: string): Promise<string | null> {
  const repositories = (await discoverRepositories(visibleRoot)).filter(
    (repo) => repo.initialised && isWithin(repo.root, absolutePath),
  );
  repositories.sort((a, b) => b.root.length - a.root.length);
  return repositories[0]?.root ?? null;
}

function requestedFile(visibleRoot: string, rel: string): string {
  if (isAbsolute(rel) || !isWithin(visibleRoot, resolve(visibleRoot, rel))) {
    throw ApiError.badRequest('path_outside_worktree', `'path' escapes the visible root`);
  }
  return resolve(visibleRoot, rel);
}

async function blob(
  root: string,
  spec: string,
): Promise<{ content: string | null; binary: boolean; exists: boolean }> {
  let buffer: Buffer;
  try {
    buffer = await gitBuffer(['show', spec], { cwd: root });
  } catch {
    return { content: null, binary: false, exists: false };
  }
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new ApiError(413, 'file_too_large', `Git baseline exceeds the editor size limit`);
  }
  const binary = buffer.subarray(0, SNIFF_BYTES).includes(0);
  return { content: binary ? null : buffer.toString('utf8'), binary, exists: true };
}

/** The index blob for the deepest repository owning the requested file. */
export async function indexFile(visibleRoot: string, rel: string): Promise<IndexFileResponse> {
  const visible = await canonical(visibleRoot);
  const absolute = requestedFile(visible, rel);
  const owner = await ownerForPath(visible, absolute);
  if (!owner) return { path: rel, content: null, binary: false, exists: false };
  const repoPath = gitPath(relative(owner, absolute));
  const result = await blob(owner, `:${repoPath}`);
  return { path: rel, ...result };
}

/** Resolve HEAD content for gutter indicators, including a staged rename. */
export async function gitOriginal(visibleRoot: string, rel: string): Promise<GitOriginalResponse> {
  const visible = await canonical(visibleRoot);
  // The ordinary editor follows filesystem symlinks when it reads a file, so
  // its HEAD model must describe that same resolved target. Looking up the
  // lexical link path instead returns Git's mode-120000 blob (just the target
  // path as text), which makes the resolved document appear wholly changed.
  const absolute = await canonical(requestedFile(visible, rel));
  const owner = await ownerForPath(visible, absolute);
  const empty = {
    path: rel,
    repository: null,
    repository_path: null,
    head: null,
    content: null,
    binary: false,
    exists: false,
    tracked: false,
    ignored: false,
  } satisfies GitOriginalResponse;
  if (!owner) return empty;

  const repoPath = gitPath(relative(owner, absolute));
  const ignored = await git(
    // `check-ignore` rejects Git's `literal` pathspec magic. Prefixing `./`
    // prevents a leading `:` from becoming magic and `--` prevents options;
    // the command receives exactly one repository-relative candidate.
    ['check-ignore', '--quiet', '--', `./${repoPath}`],
    { cwd: owner },
  )
    .then(() => true)
    .catch(() => false);
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: owner }).catch(
    () => null,
  );
  const tracked = await git(
    ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', repoPath],
    { cwd: owner },
  )
    .then(() => true)
    .catch(() => false);

  let baseline = head ? await blob(owner, `HEAD:${repoPath}`) : null;
  if (head && !baseline?.exists) {
    const status = await repositoryStatus(owner);
    const renamed = status.entries.find((entry) => entry.path === repoPath && entry.oldPath);
    if (renamed?.oldPath) baseline = await blob(owner, `HEAD:${renamed.oldPath}`);
  }
  return {
    path: rel,
    repository: owner,
    repository_path: repoPath,
    head,
    content: baseline?.content ?? null,
    binary: baseline?.binary ?? false,
    exists: baseline?.exists ?? false,
    tracked,
    ignored,
  };
}
