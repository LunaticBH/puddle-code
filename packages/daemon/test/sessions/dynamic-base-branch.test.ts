import { describe, expect, it } from 'vitest';
import { fixture } from '../helpers/daemon-fixtures.js';
import { sh } from '../helpers/git-fixtures.js';

// Keep terminal tests independent of the invoking shell's rc files.
process.env.SHELL = 'bash';

const modes = [
  { mode: 'shared directory', separate_branch: false, separate_worktree: false },
  { mode: 'separate directory', separate_branch: false, separate_worktree: true },
  { mode: 'separate branch', separate_branch: true, separate_worktree: true },
];

describe.each(['agent', 'terminal'] as const)('%s with an empty project default', (kind) => {
  it.each(modes)('follows clone branch changes in a $mode', async (mode) => {
    const f = fixture();
    f.stores.repos.patch(f.ids.repo, { default_base_branch: '' });
    const create = async () => {
      const session = await f.service.create({
        project_id: f.ids.project,
        ...(kind === 'agent' ? { account_id: f.ids.account } : { kind }),
        separate_branch: mode.separate_branch,
        separate_worktree: mode.separate_worktree,
      });
      await f.service.kill(session.id);
      return session;
    };

    const first = await create();
    expect(first.base_branch).toBe('main');
    sh(f.repoPath, 'checkout', '-b', 'develop');
    const second = await create();
    expect(second.base_branch).toBe('develop');
    expect(sh(second.worktree_path, 'branch', '--show-current')).toBe(second.branch);
    if (!mode.separate_branch) expect(second.branch).toBe('develop');
    if (!mode.separate_worktree) expect(second.worktree_path).toBe(f.repoPath);
    else expect(second.worktree_path).not.toBe(f.repoPath);
    expect(f.service.get(first.id).base_branch).toBe('main');
    expect(f.stores.repos.get(f.ids.repo).default_base_branch).toBe('');
  });

  it('honours an explicit session branch and a saved project branch', async () => {
    const f = fixture();
    f.stores.repos.patch(f.ids.repo, { default_base_branch: '' });
    sh(f.repoPath, 'checkout', '-b', 'develop');
    const input = {
      project_id: f.ids.project,
      ...(kind === 'agent' ? { account_id: f.ids.account } : { kind }),
      separate_branch: false,
      separate_worktree: false,
    };
    const explicit = await f.service.create({ ...input, base_branch: 'main' });
    await f.service.kill(explicit.id);
    expect(explicit.base_branch).toBe('main');
    expect(explicit.worktree_path).not.toBe(f.repoPath);

    f.stores.repos.patch(f.ids.repo, { default_base_branch: 'main' });
    const pinned = await f.service.create(input);
    await f.service.kill(pinned.id);
    expect(pinned.base_branch).toBe('main');
    expect(pinned.worktree_path).toBe(explicit.worktree_path);
  });

  it('falls back to main when the clone is detached', async () => {
    const f = fixture();
    f.stores.repos.patch(f.ids.repo, { default_base_branch: '' });
    sh(f.repoPath, 'checkout', '--detach');
    const session = await f.service.create({
      project_id: f.ids.project,
      ...(kind === 'agent' ? { account_id: f.ids.account } : { kind }),
      separate_branch: false,
      separate_worktree: false,
    });
    await f.service.kill(session.id);
    expect(session.base_branch).toBe('main');
    expect(session.worktree_path).not.toBe(f.repoPath);
  });
});
