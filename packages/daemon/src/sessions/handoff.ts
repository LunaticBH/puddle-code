import type { Session } from '@puddle/shared';
import type { AgentAdapter } from '../agents/adapter.js';
import type { Account } from '@puddle/shared';
import { git } from '../git/exec.js';
import type { LogStore } from '../logs/log-store.js';
import { stripAnsi } from '../pty/ansi.js';
import { quoteWindowsArgument } from '../pty/pty-spawn.js';

/**
 * Composing the tier-2 hand-off prompt (SPEC §5).
 *
 * No shared conversation format exists between agents, so the conversation is
 * summarised rather than moved: the receiving agent gets a briefing, the
 * working tree and branch carry over untouched, and the source session is left
 * exactly as it was. Degraded by design — the new agent learns *what happened*,
 * not the previous agent's private reasoning.
 */

/**
 * Characters of transcript to carry. Big enough for a meaningful briefing,
 * small enough to leave room in any agent's first-turn context — and the git
 * sections are appended AFTER truncation so they are never what gets cut.
 */
const TRANSCRIPT_BUDGET = 12_000;

/**
 * Windows only: every adapter passes the prompt as one argument, and
 * CreateProcess caps the whole command line at 32,767 characters after
 * quoting. The quoted prompt keeps well inside that, leaving room for the
 * executable, script and flags; each git section is bounded too.
 */
const WINDOWS_PROMPT_BUDGET = 24_000;
const WINDOWS_GIT_SECTION_BUDGET = 4_000;

export interface HandoffSources {
  adapter: AgentAdapter;
  account: Account;
  session: Session;
  logs: LogStore;
}

/** The full first prompt for the receiving agent. */
export async function buildHandoffPrompt(
  sources: HandoffSources,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const { session } = sources;
  const transcript = await readTranscript(sources);
  const commits = await safeGit(
    ['log', '--oneline', `${session.base_branch}..HEAD`],
    session.worktree_path,
  );
  const status = await safeGit(['status', '--short'], session.worktree_path);
  if (platform !== 'win32') {
    return composePrompt(sources, truncateTail(transcript, TRANSCRIPT_BUDGET), commits, status);
  }
  const boundedCommits = truncateHead(commits, WINDOWS_GIT_SECTION_BUDGET);
  const boundedStatus = truncateHead(status, WINDOWS_GIT_SECTION_BUDGET);
  // Quoting can lengthen the transcript (each quote gains a backslash), so
  // shrink it by the measured overflow until the quoted prompt fits.
  let budget = TRANSCRIPT_BUDGET;
  for (;;) {
    const prompt = composePrompt(
      sources,
      truncateTail(transcript, budget),
      boundedCommits,
      boundedStatus,
    );
    const overflow = quoteWindowsArgument(prompt).length - WINDOWS_PROMPT_BUDGET;
    if (overflow <= 0 || budget === 0) return prompt;
    budget = Math.max(0, budget - overflow);
  }
}

function composePrompt(
  sources: HandoffSources,
  transcript: string,
  commits: string,
  status: string,
): string {
  const { adapter, session } = sources;
  return [
    `You are taking over a coding session from another agent (${adapter.displayName}).`,
    'Below is a summary of that conversation, followed by the current state of the',
    "working tree. The previous agent's private reasoning is not included — treat",
    'this as a briefing, not a transcript you authored.',
    '',
    'Continue the work. Start by confirming your understanding of where things stand.',
    '',
    '## Conversation so far',
    '',
    transcript === '' ? '_(no transcript was available)_' : transcript,
    '',
    `## Commits on this branch (${session.base_branch}..${session.branch})`,
    '',
    commits === '' ? '_(none yet)_' : '```\n' + commits + '\n```',
    '',
    '## Working tree',
    '',
    status === '' ? '_(clean)_' : '```\n' + status + '\n```',
  ].join('\n');
}

/**
 * The source agent's own transcript, or the recorded PTY output as a fallback.
 * Adapters that cannot render their conversation simply omit `exportTranscript`;
 * the PTY log is agent-agnostic and always there, just noisier.
 */
async function readTranscript(sources: HandoffSources): Promise<string> {
  const { adapter, account, session, logs } = sources;
  const ref = session.agent_session_ref;
  if (adapter.exportTranscript && ref !== null) {
    try {
      const text = await adapter.exportTranscript(ref, account, session.worktree_path);
      if (text.trim() !== '') return text.trim();
    } catch {
      // Fall through to the PTY log rather than failing the hand-off.
    }
  }
  try {
    // The raw terminal stream: ANSI stripped, and TUI redraw blank lines
    // collapsed so the budget is spent on content rather than whitespace.
    const tail = stripAnsi(logs.readTail(session.id, 'agent'));
    return tail.replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return '';
  }
}

/** Keeps the first `budget` characters, at a line boundary, counting the lines dropped. */
function truncateHead(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget);
  const nl = cut.lastIndexOf('\n');
  const kept = nl === -1 ? cut : cut.slice(0, nl);
  const omitted = text.slice(kept.length).split('\n').filter(Boolean).length;
  return `${kept}\n… (${omitted} more lines omitted)`;
}

/** Keeps the last `budget` characters, marking that earlier turns were dropped. */
function truncateTail(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget === 0) return '_(earlier turns omitted)_';
  // Recent turns matter most, so cut from the front — at a line boundary.
  const cut = text.slice(text.length - budget);
  const nl = cut.indexOf('\n');
  return `_(earlier turns omitted)_\n\n${nl === -1 ? cut : cut.slice(nl + 1)}`;
}

/** git output, or '' — a hand-off must never fail on a git hiccup. */
async function safeGit(args: string[], cwd: string): Promise<string> {
  try {
    return (await git(args, { cwd })).trim();
  } catch {
    return '';
  }
}
