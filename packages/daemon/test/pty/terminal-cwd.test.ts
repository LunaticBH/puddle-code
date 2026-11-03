import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/pty/ansi.js';
import { fixture, waitFor, type Fixture } from '../helpers/daemon-fixtures.js';

// The fake terminal is a real shell: cmd.exe on Windows, where `cd` prints the
// directory (SHELL must name an existing executable there), else $SHELL.
const windows = process.platform === 'win32';
if (windows) process.env.SHELL = process.env.ComSpec;

/** Ask the shell where it is; the answer lands in the terminal log. */
function askDirectory(f: Fixture, id: string): void {
  f.ptys.resize(id, 'agent', 400, 40); // wide enough that a deep temp path never wraps
  f.ptys.write(id, 'agent', windows ? 'cd\r' : 'pwd\n');
}

/** Whether the terminal printed a directory ending in `relative` (`/`-separated). */
function printed(f: Fixture, id: string, relative: string): boolean {
  const native = windows ? relative.replaceAll('/', '\\') : relative;
  return stripAnsi(f.logs.readTail(id, 'agent')).includes(native);
}

/**
 * "Open terminal in directory" (SPEC §8): the shell starts in a subdirectory of
 * the worktree the session still belongs to.
 */
describe('terminal session cwd', () => {
  it('starts the shell in the requested subdirectory', async () => {
    const f = fixture();
    const owner = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    const sub = join(owner.worktree_path, 'nested', 'deep');
    mkdirSync(sub, { recursive: true });

    const term = await f.service.create({
      project_id: f.ids.project,
      kind: 'terminal',
      separate_branch: false,
      separate_worktree: false,
      join_worktree: owner.worktree_path,
      cwd: 'nested/deep',
    });
    // The session still belongs to the WORKTREE — only the shell's cwd differs.
    expect(term.worktree_path).toBe(owner.worktree_path);

    askDirectory(f, term.id);
    await waitFor(() => printed(f, term.id, 'nested/deep'));

    await f.service.kill(term.id).catch(() => undefined);
    await f.service.kill(owner.id).catch(() => undefined);
  });

  it('persists the cwd and resumes back into it', async () => {
    const f = fixture();
    const owner = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    mkdirSync(join(owner.worktree_path, 'nested', 'deep'), { recursive: true });
    const term = await f.service.create({
      project_id: f.ids.project,
      kind: 'terminal',
      separate_branch: false,
      separate_worktree: false,
      join_worktree: owner.worktree_path,
      cwd: 'nested/deep',
    });
    // Stored worktree-RELATIVE, so it cannot drift from worktree_path.
    expect(f.service.get(term.id).cwd).toBe('nested/deep');

    // The restart case this exists for: kill the shell, resume, still there.
    await f.service.kill(term.id);
    await f.service.resume(term.id);
    askDirectory(f, term.id);
    await waitFor(() => printed(f, term.id, 'nested/deep'));

    await f.service.kill(term.id).catch(() => undefined);
    await f.service.kill(owner.id).catch(() => undefined);
  });

  it('tracks a later cd and resumes in the prompt-reported directory', async () => {
    const f = fixture();
    const term = await f.service.create({
      project_id: f.ids.project,
      kind: 'terminal',
      separate_branch: false,
    });
    const nested = join(term.worktree_path, 'changed', 'later');
    mkdirSync(nested, { recursive: true });

    // The real shell hook emits this at the next prompt after `cd`.
    f.ptys.emit('cwd', { stream: term.id, term: 'agent', cwd: nested });
    expect(f.service.get(term.id).cwd).toBe('changed/later');

    await f.service.kill(term.id);
    await f.service.resume(term.id);
    askDirectory(f, term.id);
    await waitFor(() => printed(f, term.id, 'changed/later'));
    await f.service.kill(term.id).catch(() => undefined);
  });

  it('does not persist a prompt directory outside the worktree', async () => {
    const f = fixture();
    const term = await f.service.create({
      project_id: f.ids.project,
      kind: 'terminal',
      separate_branch: false,
    });
    f.ptys.emit('cwd', { stream: term.id, term: 'agent', cwd: tmpdir() });
    expect(f.service.get(term.id).cwd ?? null).toBeNull();
    await f.service.kill(term.id).catch(() => undefined);
  });

  it('falls back to the worktree root when the directory has since gone', async () => {
    const f = fixture();
    const owner = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    const doomed = join(owner.worktree_path, 'temporary');
    mkdirSync(doomed, { recursive: true });
    const term = await f.service.create({
      project_id: f.ids.project,
      kind: 'terminal',
      separate_branch: false,
      separate_worktree: false,
      join_worktree: owner.worktree_path,
      cwd: 'temporary',
    });
    await f.service.kill(term.id);
    rmSync(doomed, { recursive: true, force: true });

    // A stale cwd must not make the session unspawnable.
    await expect(f.service.resume(term.id)).resolves.toBeTruthy();
    await f.service.kill(term.id).catch(() => undefined);
    await f.service.kill(owner.id).catch(() => undefined);
  });

  it('leaves an ordinary terminal at the worktree root', async () => {
    const f = fixture();
    const term = await f.service.create({
      project_id: f.ids.project,
      kind: 'terminal',
      separate_branch: false,
    });
    expect(f.service.get(term.id).cwd ?? null).toBeNull();
    await f.service.kill(term.id).catch(() => undefined);
  });

  it('rejects a cwd that escapes the worktree, or is not a directory', async () => {
    const f = fixture();
    const owner = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    const base = {
      project_id: f.ids.project,
      kind: 'terminal' as const,
      separate_branch: false,
      separate_worktree: false,
      join_worktree: owner.worktree_path,
    };
    await expect(f.service.create({ ...base, cwd: '../../etc' })).rejects.toMatchObject({
      code: 'path_outside_worktree',
    });
    await expect(f.service.create({ ...base, cwd: 'no-such-dir' })).rejects.toMatchObject({
      code: 'cwd_not_a_directory',
    });
    await f.service.kill(owner.id).catch(() => undefined);
  });

  it('refuses a cwd on an agent session — it is a terminal-only option', async () => {
    const f = fixture();
    await expect(
      f.service.create({ project_id: f.ids.project, account_id: f.ids.account, cwd: 'src' }),
    ).rejects.toMatchObject({ code: 'cwd_terminal_only' });
  });
});
