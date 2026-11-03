import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture } from '../helpers/daemon-fixtures.js';
import { sh } from '../helpers/git-fixtures.js';

// Keep terminal tests independent of the invoking shell's rc files.
process.env.SHELL = 'bash';

describe.each(['agent', 'terminal'] as const)('%s in a repository without commits', (kind) => {
  it.each(['main', 'trunk'])('shares the unborn %s branch without a remote', async (branch) => {
    const f = fixture();
    const path = mkdtempSync(join(tmpdir(), 'puddle-unborn-session-'));
    sh(path, 'init', '-b', branch);
    writeFileSync(join(path, 'staged.txt'), 'staged work\n');
    sh(path, 'add', 'staged.txt');
    writeFileSync(join(path, 'untracked.txt'), 'untracked work\n');
    const status = sh(path, 'status', '--porcelain');
    const repo = f.stores.repos.create({
      path,
      default_base_branch: '',
      onboarding_notes: null,
      fetch_enabled: true,
    });
    const project = f.stores.projects.create({
      profile_id: f.ids.profile,
      repo_id: repo.id,
      name: 'local project',
    });
    const input = {
      project_id: project.id,
      ...(kind === 'agent' ? { account_id: f.ids.account } : { kind }),
      separate_branch: false,
      separate_worktree: false,
    };

    for (const base of [undefined, branch]) {
      const session = await f.service.create({ ...input, base_branch: base });
      await f.service.kill(session.id);
      expect(session.worktree_path).toBe(path);
      expect(session.branch).toBe(branch);
      expect(session.base_branch).toBe(branch);
      expect(session.branch_owner).toBe(false);
    }

    // Starting a session must not invent a commit or alter the user's files/index.
    expect(sh(path, 'remote')).toBe('');
    expect(sh(path, 'for-each-ref', '--format=%(refname)')).toBe('');
    expect(sh(path, 'symbolic-ref', '--short', 'HEAD')).toBe(branch);
    expect(sh(path, 'status', '--porcelain')).toBe(status);
    expect(readFileSync(join(path, 'staged.txt'), 'utf8')).toBe('staged work\n');
    expect(readFileSync(join(path, 'untracked.txt'), 'utf8')).toBe('untracked work\n');
    expect(sh(path, 'check-ignore', '.puddle/')).toBe('.puddle/');

    await expect(f.service.create({ ...input, base_branch: 'missing' })).rejects.toMatchObject({
      code: 'unknown_base',
    });
  });
});
