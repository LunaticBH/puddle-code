import type { Session } from '@puddle/shared';
import { DEFAULT_TAB_TITLE_TEMPLATE, hostBasename, hostPathStyle } from '@puddle/shared';

/** The fields a tab-title template can draw on. A full `Session` satisfies it. */
export type TitleSession = Pick<
  Session,
  | 'id'
  | 'title'
  | 'agent_title'
  | 'osc_title'
  | 'branch'
  | 'worktree_path'
  | 'status'
  | 'agent_type'
>;

/**
 * A session's resolved display name: the user's rename override if set, else the
 * agent's own session name (for Claude Code, its transcript title), else the
 * terminal-title "sequence" name the process set, else the leading block of the
 * session id. Mirrors the daemon's precedence and is the `${name}` variable of a
 * tab-title template (SPEC §4).
 */
export function sessionDisplayName(
  session: Pick<Session, 'id' | 'title' | 'agent_title' | 'osc_title'>,
): string {
  return session.title ?? session.agent_title ?? session.osc_title ?? session.id.slice(0, 8);
}

/** The em-dash `${separator}` glyph, shown only between two non-empty neighbours. */
const SEPARATOR = ' — ';

/** The worktree directory's name; a Windows host's path splits on `\` too. */
function basename(path: string): string {
  if (hostPathStyle(path) === 'win32') return hostBasename(path);
  return path.replace(/\/+$/, '').split('/').pop() ?? '';
}

function variables(session: TitleSession): Record<string, string> {
  return {
    name: sessionDisplayName(session),
    title: session.title ?? '',
    agentName: session.agent_title ?? '',
    sequence: session.osc_title ?? '',
    branch: session.branch,
    cwd: basename(session.worktree_path),
    id: session.id.slice(0, 8),
    status: session.status,
    agent: session.agent_type ?? '',
  };
}

/**
 * Compose a session's tab label from a profile's `tabTitleTemplate` (SPEC §4).
 * `${variable}` tokens are substituted; an unknown token is left verbatim (so a
 * typo is visible). `${separator}` renders its em dash only when non-empty
 * content sits on both sides, so `${branch}${separator}${name}` collapses to
 * just the name when there is no branch. An all-empty render falls back to the
 * session-id prefix, so a tab is never nameless.
 */
export function renderSessionTitle(session: TitleSession, template?: string): string {
  const tmpl = template && template.length > 0 ? template : DEFAULT_TAB_TITLE_TEMPLATE;
  const vars = variables(session);
  const segs: Array<{ text: string; sep: boolean }> = [];
  for (const part of tmpl.split(/(\$\{[a-zA-Z]+\})/)) {
    if (part === '') continue;
    const name = /^\$\{([a-zA-Z]+)\}$/.exec(part)?.[1];
    if (name === undefined) {
      segs.push({ text: part, sep: false });
    } else if (name === 'separator') {
      segs.push({ text: SEPARATOR, sep: true });
    } else {
      segs.push({ text: vars[name] ?? part, sep: false });
    }
  }
  const out: string[] = [];
  segs.forEach((seg, i) => {
    if (!seg.sep) {
      out.push(seg.text);
      return;
    }
    const hasLeft = out.join('').trim().length > 0;
    const hasRight = segs.slice(i + 1).some((s) => !s.sep && s.text.trim().length > 0);
    if (hasLeft && hasRight) out.push(seg.text);
  });
  const result = out.join('').trim();
  return result.length > 0 ? result : session.id.slice(0, 8);
}
