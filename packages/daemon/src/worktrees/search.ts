import type { SearchFileMatches, SearchResponse } from '@puddle/shared';
import { git, GitError } from '../git/exec.js';
import { ApiError } from '../http/errors.js';

/**
 * Filename + content search for one worktree (SPEC §8, Search navigator).
 * Content search is `git grep` over the working tree plus untracked-not-ignored
 * files; filename search subsequence-matches the same file set (`ls-files`),
 * so a single request feeds both the "Files" and "Contents" sections. Nothing
 * here mutates the repo, so — like `inspect.ts` — it runs outside the per-repo
 * mutex.
 */

export interface SearchOptions {
  query: string;
  /** Treat the query as an extended regular expression rather than a fixed string. */
  regex: boolean;
  caseSensitive: boolean;
  /** Match on word boundaries only. */
  wholeWord: boolean;
}

/** Per-list caps: keep a huge repo from flooding the navigator (and the wire). */
const MAX_CONTENT_FILES = 200;
const MAX_MATCHES_PER_FILE = 50;
const MAX_FILENAME_HITS = 200;

/** Subsequence test (fuzzy filename match): are `needle`'s chars found in order in `hay`? */
function subsequence(hay: string, needle: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Files whose path matches `query`: a plain case-insensitive substring wins
 * (ranked first, and by how early the hit lands), otherwise a subsequence
 * match (VS Code / Obsidian quick-open behaviour). Searches tracked and
 * untracked-not-ignored files alike.
 */
async function filenameMatches(worktree: string, query: string): Promise<string[]> {
  const raw = await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: worktree,
  });
  const paths = raw.split('\0').filter((p) => p.length > 0);
  const needle = query.toLowerCase();

  const scored: { path: string; rank: number }[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const idx = lower.indexOf(needle);
    if (idx !== -1) {
      // Substring: prefer a hit in the basename, then an earlier position.
      const base = lower.lastIndexOf('/') + 1;
      scored.push({ path, rank: idx >= base ? idx - base : idx + 1000 });
    } else if (subsequence(lower, needle)) {
      scored.push({ path, rank: 5000 + path.length });
    }
  }
  scored.sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path));
  return scored.slice(0, MAX_FILENAME_HITS).map((s) => s.path);
}

/**
 * Content matches via `git grep -n --null` (`path\0line\0text` per record).
 * `-I` skips binaries; `--untracked` folds in untracked-not-ignored files so
 * results match what the file explorer shows. A no-match run exits 1, which
 * `git()` surfaces as a `GitError` — caught here and returned as no matches.
 */
async function contentMatches(
  worktree: string,
  opts: SearchOptions,
): Promise<{ files: SearchFileMatches[]; truncated: boolean }> {
  const args = ['grep', '--no-color', '-n', '-I', '--null', '--untracked'];
  if (!opts.caseSensitive) args.push('-i');
  if (opts.wholeWord) args.push('-w');
  // Regex mode uses PCRE (`-P`), not POSIX ERE (`-E`): it supports the
  // `\w`/`\d`/`\b` idioms users expect (and that the client's JS-regex
  // highlighter uses), keeping server matches and client highlighting aligned.
  // A git built without PCRE errors out — surfaced to the caller as a 400.
  args.push(opts.regex ? '-P' : '-F');
  // `-e <pattern>` keeps a leading `-` in the query from being read as a flag.
  args.push('-e', opts.query, '--');

  let raw: string;
  try {
    raw = await git(args, { cwd: worktree });
  } catch (e) {
    // git grep exits 1 for "no matches" (not an error). Any other non-zero
    // exit is almost always a bad pattern (e.g. an invalid regex the user is
    // still typing) — surface it as a 400, never a 500.
    if (e instanceof GitError) {
      if (e.exitCode === 1) return { files: [], truncated: false };
      throw ApiError.badRequest('invalid_search', e.stderr.trim() || 'search failed');
    }
    throw e;
  }

  const byPath = new Map<string, SearchFileMatches>();
  let truncated = false;
  for (const record of raw.split('\n')) {
    if (record.length === 0) continue;
    const first = record.indexOf('\0');
    const second = record.indexOf('\0', first + 1);
    if (first === -1 || second === -1) continue;
    const path = record.slice(0, first);
    const line = Number(record.slice(first + 1, second));
    const matched = record.slice(second + 1);
    // Git for Windows checks files out with CRLF (core.autocrlf), and grep
    // keeps the carriage return on every matched line.
    const text =
      process.platform === 'win32' && matched.endsWith('\r') ? matched.slice(0, -1) : matched;
    if (!Number.isFinite(line)) continue;

    let entry = byPath.get(path);
    if (!entry) {
      if (byPath.size >= MAX_CONTENT_FILES) {
        truncated = true;
        continue;
      }
      entry = { path, matches: [] };
      byPath.set(path, entry);
    }
    if (entry.matches.length >= MAX_MATCHES_PER_FILE) {
      truncated = true;
      continue;
    }
    entry.matches.push({ line, text });
  }

  return { files: [...byPath.values()], truncated };
}

export async function searchWorktree(
  worktree: string,
  opts: SearchOptions,
): Promise<SearchResponse> {
  const [files, content] = await Promise.all([
    filenameMatches(worktree, opts.query),
    contentMatches(worktree, opts),
  ]);
  return {
    query: opts.query,
    files,
    content: content.files,
    truncated: content.truncated || files.length >= MAX_FILENAME_HITS,
  };
}
