/**
 * Pure-logic tests for the session tab-title templating (SPEC §4): the
 * fallback display name and the `${…}` template renderer with its conditional
 * separator.
 */
import { describe, expect, it } from 'vitest';
import type { Session } from '@puddle/shared';
import {
  renderSessionTitle,
  sessionDisplayName,
  type TitleSession,
} from '../../src/lib/session-display';

function session(over: Partial<TitleSession> = {}): TitleSession {
  return {
    id: 'abcdef12-3456-7890-abcd-ef1234567890',
    title: null,
    agent_title: null,
    osc_title: null,
    branch: 'alice/feature',
    worktree_path: '/home/alice/code/app--feature',
    status: 'running' as Session['status'],
    agent_type: 'claude-code',
    ...over,
  };
}

describe('sessionDisplayName', () => {
  it('prefers title, then agent_title, then osc_title, then the id prefix', () => {
    expect(sessionDisplayName(session({ title: 'mine', agent_title: 'a', osc_title: 'o' }))).toBe(
      'mine',
    );
    expect(sessionDisplayName(session({ agent_title: 'a', osc_title: 'o' }))).toBe('a');
    expect(sessionDisplayName(session({ osc_title: 'o' }))).toBe('o');
    expect(sessionDisplayName(session())).toBe('abcdef12');
  });
});

describe('renderSessionTitle', () => {
  it('defaults to the resolved name (${name})', () => {
    expect(renderSessionTitle(session({ agent_title: 'Refactor auth' }))).toBe('Refactor auth');
    expect(renderSessionTitle(session({ agent_title: 'Refactor auth' }), '')).toBe('Refactor auth');
  });

  it('substitutes each variable', () => {
    const s = session({ title: 'T', agent_title: 'A', osc_title: 'S' });
    expect(renderSessionTitle(s, '${title}')).toBe('T');
    expect(renderSessionTitle(s, '${agentName}')).toBe('A');
    expect(renderSessionTitle(s, '${sequence}')).toBe('S');
    expect(renderSessionTitle(s, '${branch}')).toBe('alice/feature');
    expect(renderSessionTitle(s, '${cwd}')).toBe('app--feature');
    expect(renderSessionTitle(s, '${id}')).toBe('abcdef12');
    expect(renderSessionTitle(s, '${status}')).toBe('running');
    expect(renderSessionTitle(s, '${agent}')).toBe('claude-code');
  });

  it('shows the separator only between two non-empty neighbours', () => {
    const withBranch = session({ agent_title: 'Task' });
    expect(renderSessionTitle(withBranch, '${branch}${separator}${name}')).toBe(
      'alice/feature — Task',
    );
    // No branch → the separator collapses rather than leaving a dangling dash.
    const noBranch = session({ agent_title: 'Task', branch: '' });
    expect(renderSessionTitle(noBranch, '${branch}${separator}${name}')).toBe('Task');
  });

  it('leaves an unknown variable verbatim so a typo is visible', () => {
    expect(renderSessionTitle(session({ agent_title: 'x' }), '${nope}-${name}')).toBe('${nope}-x');
  });

  it('falls back to the id prefix when the render is empty', () => {
    // Only empty variables chosen → nothing renders → id prefix.
    expect(renderSessionTitle(session(), '${title}${separator}${sequence}')).toBe('abcdef12');
  });
});
