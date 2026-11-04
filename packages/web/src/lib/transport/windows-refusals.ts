import { ApiError } from './api';

/**
 * Puddle's wording for the refusals only a Windows host makes
 * (docs/windows.md, decision 11), or null for every other error. Callers try
 * this first and fall back to what they showed before, so an error from a
 * Linux or macOS host reads exactly as it always has. The daemon's message
 * carries the specifics (the path, the rule broken, git's advice); this turns
 * each into a sentence that says what happened and what to do next.
 *
 * - 400 `invalid_name`: a name Windows cannot store. The same code also
 *   rejects a malformed untitled-draft name on every host; that message has
 *   another shape and is left alone.
 * - 409 `path_busy`: another program holds the entry open, so Windows cannot
 *   move or delete it. Windows reports a handle held inside a folder as
 *   access denied, just as it reports a permission it refuses, so that shape
 *   names both causes.
 * - 409 `source_not_removed`: a move to another drive copied everything but
 *   could not remove the whole original.
 * - 409 `worktree_busy` with the open-handle cause. Its other cause, running
 *   sessions, comes from every host and is left alone.
 * - 400 `unsafe_repository`: git's safe.directory refusal, with git's advice.
 */
export function windowsRefusalMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case 'invalid_name':
      return invalidName(error.message);
    case 'path_busy':
      return pathBusy(error.message);
    case 'source_not_removed':
      return sourceNotRemoved(error.message);
    case 'worktree_busy':
      return worktreeHeldOpen(error.message);
    case 'unsafe_repository':
      return unsafeRepository(error.message);
    default:
      return null;
  }
}

/** The sentence for a name Windows cannot store, shared with the UI's own pre-validation. */
export function invalidNameMessage(name: string, problem: string): string {
  return `Can't use the name '${name}': ${problem}.`;
}

/** Daemon: `'<path>' cannot be created: <problem>`. */
function invalidName(message: string): string | null {
  const match = /^'(.*)' cannot be created: (.+)$/s.exec(message);
  return match ? invalidNameMessage(match[1]!, match[2]!) : null;
}

const HELD_OPEN = 'open in another program (a terminal, editor or dev server)';

function subjectOf(path: string | undefined): string {
  return path === undefined || path === '.' ? 'This item' : `'${path}'`;
}

/**
 * Daemon: `<path> is in use by another program (…); close it and try again`
 * for a sharing violation, or `<path> could not be changed: it is open in
 * another program (…), or you do not have permission to change it` when
 * Windows denied access.
 */
function pathBusy(message: string): string {
  const denied = /^(.+?) could not be changed: /s.exec(message);
  if (denied) {
    return (
      `${subjectOf(denied[1])} is ${HELD_OPEN}, or you don't have permission to change it, ` +
      "so Windows can't move or delete it. Close it there, or check its permissions, and try again."
    );
  }
  const path = /^(.+?) is in use by another program\b/s.exec(message)?.[1];
  return `${subjectOf(path)} is ${HELD_OPEN}, so Windows can't move or delete it. Close it there and try again.`;
}

/** Daemon: `<path> was copied, but its original could not be removed completely: …`. */
function sourceNotRemoved(message: string): string {
  const path = /^(.+?) was copied, but\b/s.exec(message)?.[1];
  return (
    `${subjectOf(path)} was copied, but Windows couldn't remove all of the original: something ` +
    `in it is ${HELD_OPEN}, or you don't have permission to delete it. Close it, then delete ` +
    'what is left of the original.'
  );
}

/** Daemon: `files in <path> are open in another program (…) — close them and try again`. */
function worktreeHeldOpen(message: string): string | null {
  if (!/\bopen in another program\b/.test(message)) return null;
  return (
    "Windows can't remove this worktree while files in it are open in another program " +
    '(a terminal, agent, editor or dev server). Close them, then remove the worktree again.'
  );
}

/**
 * Daemon: git's own `detected dubious ownership` text, ending with its advice
 * (`git config --global --add safe.directory <dir>`, the directory quoted only
 * when it needs to be). The command goes last, so no punctuation joins it.
 */
function unsafeRepository(message: string): string {
  const repository = /repository at '([^']+)'/.exec(message)?.[1];
  const advice = /git config --global --add safe\.directory .+/.exec(message)?.[0].trim();
  const subject = repository === undefined ? 'this repository' : `'${repository}'`;
  const fix =
    advice === undefined
      ? "add it to git's safe.directory list on the host, then try again."
      : `run this on the host, then try again: ${advice}`;
  return `Git refuses to open ${subject} because another user owns it. If you trust it, ${fix}`;
}
