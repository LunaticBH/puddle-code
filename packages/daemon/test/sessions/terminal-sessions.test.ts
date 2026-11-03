import { describe, expect, it } from 'vitest';
import { fakeAdapter, fixture, waitFor } from '../helpers/daemon-fixtures.js';
import { sh } from '../helpers/git-fixtures.js';

/** Terminal sessions (SPEC §4): a plain shell PTY, no account, no agent. */

// A terminal session spawns the real `$SHELL`. The interactive login shell on a
// dev box (often zsh with a heavy rc) is slow to start and, spawned repeatedly
// across the parallel suite, can starve sibling tests — so pin this file's fork
// to a lightweight bash (cmd.exe on Windows, where SHELL must name an existing
// executable). Vitest's default `forks` pool isolates this env change to this
// file's own child process.
const windows = process.platform === 'win32';
process.env.SHELL = windows ? process.env.ComSpec : 'bash';

describe('terminal sessions', () => {
  // Suspension (Ctrl+Z, fg) is POSIX job control; Windows is covered below.
  it.skipIf(windows)(
    'reports a foreground agent hint, clears it on suspension/exit, and keeps terminal identity',
    async () => {
      const f = fixture({
        adapter: {
          ...fakeAdapter(),
          matchesProcess: (command) => command === '/bin/sleep 30',
        },
      });
      const session = await f.service.create({ project_id: f.ids.project, kind: 'terminal' });
      const changes: string[][] = [];
      f.service.on('sessions-changed', (event: { projectIds: string[] }) =>
        changes.push(event.projectIds),
      );
      await waitFor(() => f.service.get(session.id).status === 'running');
      f.ptys.write(session.id, 'agent', '/bin/sleep 30\r');
      await waitFor(() => f.service.get(session.id).detected_agent_type === 'fake', 10_000);
      expect(f.service.list({ project_id: f.ids.project })[0]).toMatchObject({
        kind: 'terminal',
        account_id: null,
        agent_type: null,
        detected_agent_type: 'fake',
      });
      expect(f.stores.sessions.get(session.id).detected_agent_type).toBeUndefined();
      expect(changes).toContainEqual([f.ids.project]);

      f.ptys.write(session.id, 'agent', '\x1a'); // Ctrl+Z: suspended jobs cannot claim the icon.
      await waitFor(() => f.service.get(session.id).detected_agent_type === null, 10_000);
      f.ptys.write(session.id, 'agent', 'fg\r');
      await waitFor(() => f.service.get(session.id).detected_agent_type === 'fake', 10_000);
      f.ptys.write(session.id, 'agent', '\x03');
      await waitFor(() => f.service.get(session.id).detected_agent_type === null, 10_000);
      expect(f.service.get(session.id).status).toBe('running');
      await f.service.kill(session.id);
      expect(f.service.get(session.id).detected_agent_type).toBeNull();
    },
  );

  it.skipIf(!windows)(
    'reports a foreground agent hint on Windows, clears it on exit, and keeps terminal identity',
    async () => {
      const f = fixture({
        adapter: {
          ...fakeAdapter(),
          // The process table's shape: image name, then `/`-separated arguments.
          matchesProcess: (command) =>
            command.startsWith('node ') && command.includes('puddle-agent-probe'),
        },
      });
      const session = await f.service.create({ project_id: f.ids.project, kind: 'terminal' });
      await waitFor(() => f.service.get(session.id).status === 'running');
      f.ptys.write(
        session.id,
        'agent',
        `"${process.execPath}" -e "setTimeout(() => {}, 30000)" puddle-agent-probe\r`,
      );
      await waitFor(() => f.service.get(session.id).detected_agent_type === 'fake', 15_000);
      expect(f.service.list({ project_id: f.ids.project })[0]).toMatchObject({
        kind: 'terminal',
        account_id: null,
        agent_type: null,
        detected_agent_type: 'fake',
      });
      f.ptys.write(session.id, 'agent', '\x03'); // Ctrl+C ends the agent, not the shell
      await waitFor(() => f.service.get(session.id).detected_agent_type === null, 15_000);
      expect(f.service.get(session.id).status).toBe('running');
      await f.service.kill(session.id);
      expect(f.service.get(session.id).detected_agent_type).toBeNull();
    },
  );

  it('opens a shell on the base branch by default — no account, no agent, no onboarding', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      kind: 'terminal',
    });

    // Shape: no account/agent; a terminal defaults to sharing the base branch's
    // directory — the repo's own clone when that branch is checked out there.
    expect(session.kind).toBe('terminal');
    expect(session.account_id).toBeNull();
    expect(session.agent_type).toBeNull();
    expect(session.separate_branch).toBe(false);
    expect(session.branch).toBe('main');
    expect(session.worktree_path).toBe(f.repoPath);
    expect(sh(session.worktree_path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    // The shell comes up (starting → running on its first prompt) and never
    // receives the onboarding preamble an agent would.
    await waitFor(() => f.service.get(session.id).status === 'running');
    expect(f.logs.readTail(session.id, 'agent')).not.toContain('freshly created git worktree');

    await f.service.kill(session.id);
    expect(f.service.get(session.id).status).toBe('exited');
  });

  it('can take a separate branch, and resume relaunches a fresh shell', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      kind: 'terminal',
      separate_branch: true,
    });
    expect(session.separate_branch).toBe(true);
    expect(session.branch).not.toBe('main');
    expect(session.branch.startsWith('alice/')).toBe(true);

    await waitFor(() => f.service.get(session.id).status === 'running');
    await f.service.kill(session.id);
    expect(f.service.get(session.id).status).toBe('exited');

    // "Resume" a terminal = relaunch a shell in the same worktree (there is no
    // conversation to restore), so it goes live again like any other session.
    const resumed = await f.service.resume(session.id);
    expect(resumed.status).toBe('running');
    await waitFor(() => f.service.get(session.id).status === 'running');
    await f.service.kill(session.id);
  });

  it('rejects a branch name alongside the default shared worktree', async () => {
    const f = fixture();
    await expect(
      f.service.create({
        project_id: f.ids.project,
        kind: 'terminal',
        branch: 'some-branch',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'branch_with_shared' });
  });

  it('still requires an account for an agent session', async () => {
    const f = fixture();
    await expect(f.service.create({ project_id: f.ids.project })).rejects.toMatchObject({
      status: 400,
      code: 'account_required',
    });
  });
});
