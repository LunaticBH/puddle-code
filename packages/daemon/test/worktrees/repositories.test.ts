import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  commitRepository,
  discoverRepositories,
  fetchRepository,
  gitOriginal,
  gitRepositories,
  indexFile,
  parsePorcelainV2,
  pullRepository,
  pushRepository,
  stagePaths,
  unstagePaths,
  withPathspecs,
} from '../../src/worktrees/repositories.js';
import { cloneRepo, commitFile, initRepo, sh } from '../helpers/git-fixtures.js';

const cleanup: string[] = [];
afterAll(() => {
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
});

function tracked(repo: string, name: string, content: string): void {
  writeFileSync(join(repo, name), content);
  sh(repo, 'add', '--', name);
  sh(repo, 'commit', '-m', `add ${name}`);
}

describe('porcelain-v2 status parsing', () => {
  it('separates branch metadata, staged/unstaged columns, conflicts, and literal paths', () => {
    const raw =
      '# branch.oid abcdef\0# branch.head main\0# branch.upstream origin/main\0' +
      '# branch.ab +2 -3\0' +
      '1 MM N... 100644 100644 100644 a b tracked file.txt\0' +
      '2 R. N... 100644 100644 100644 a b R100 renamed.txt\0old.txt\0' +
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt\0' +
      '? fresh.txt\0! ignored.txt\0';
    const status = parsePorcelainV2(raw);
    expect(status).toMatchObject({
      head: 'abcdef',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 3,
    });
    expect(status.entries).toEqual([
      expect.objectContaining({ path: 'tracked file.txt', x: 'M', y: 'M' }),
      expect.objectContaining({ path: 'renamed.txt', oldPath: 'old.txt', x: 'R', y: '.' }),
      expect.objectContaining({ path: 'conflict.txt', conflict: true }),
      expect.objectContaining({ path: 'fresh.txt', untracked: true }),
      expect.objectContaining({ path: 'ignored.txt', ignored: true }),
    ]);
  });
});

describe('repository discovery and precedence', () => {
  it('covers an outer modification and an ignored nested repository', async () => {
    const outer = initRepo();
    cleanup.push(outer);
    writeFileSync(join(outer, 'README.md'), '# outer changed\n');
    writeFileSync(join(outer, '.gitignore'), 'brain/\n');
    sh(outer, 'add', '.gitignore');
    sh(outer, 'commit', '-m', 'ignore brain');

    const nested = join(outer, 'brain');
    execFileSync('git', ['init', '-b', 'main', nested]);
    sh(nested, 'config', 'user.email', 'nested@example.com');
    sh(nested, 'config', 'user.name', 'nested');
    tracked(nested, 'thought.txt', 'first\n');
    writeFileSync(join(nested, 'thought.txt'), 'second\n');

    const result = await gitRepositories(outer);
    expect(result.repositories.map((repository) => repository.root)).toEqual([
      realpathSync(outer),
      realpathSync(nested),
    ]);
    expect(result.repositories[0]?.owning).toBe(true);
    expect(result.repositories[1]?.staged).toEqual([]);
    expect(result.repositories[1]?.unstaged).toEqual([
      expect.objectContaining({ path: 'thought.txt', status: 'modified' }),
    ]);
    expect(result.entries).toContainEqual({ path: 'README.md', status: 'modified' });
    expect(result.entries).toContainEqual({ path: 'brain/thought.txt', status: 'modified' });
    expect(result.entries).not.toContainEqual({ path: 'brain', status: 'ignored' });
  });

  it('lists initialised and uninitialised recursive submodules', async () => {
    const child = initRepo();
    const outer = initRepo();
    cleanup.push(child, outer);
    sh(outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'module');
    sh(outer, 'commit', '-m', 'add module');

    let repositories = await discoverRepositories(outer);
    expect(repositories).toContainEqual(
      expect.objectContaining({
        root: realpathSync(join(outer, 'module')),
        submodule: true,
        initialised: true,
      }),
    );

    sh(outer, 'submodule', 'deinit', '-f', 'module');
    repositories = await discoverRepositories(outer);
    expect(repositories).toContainEqual(
      expect.objectContaining({
        root: realpathSync(join(outer, 'module')),
        submodule: true,
        initialised: false,
      }),
    );
  });
});

describe('source-control mutations and baselines', () => {
  it('handles partial staging, literal pathspecs, commit, unstage, and conflicts', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    // NTFS cannot store `:`. Windows uses wildcard magic it can store instead,
    // with a decoy the wildcard would also match unless paths stay literal.
    const magic = process.platform === 'win32' ? '[x]literal.txt' : ':(glob)literal.txt';
    if (process.platform === 'win32') writeFileSync(join(repo, 'xliteral.txt'), 'decoy\n');
    const dash = '-dash.txt';
    writeFileSync(join(repo, magic), 'magic\n');
    writeFileSync(join(repo, dash), 'dash\n');
    await expect(stagePaths(repo, repo, ['../escape.txt'])).rejects.toMatchObject({
      code: 'path_outside_repository',
    });
    await stagePaths(repo, repo, [magic, dash]);
    await unstagePaths(repo, repo, [magic]);
    let status = await gitRepositories(repo);
    expect(status.repositories[0]?.staged.map((entry) => entry.path)).toEqual([dash]);
    expect(status.repositories[0]?.unstaged.map((entry) => entry.path)).toContain(magic);
    await commitRepository(repo, repo, 'literal stage', false);
    expect(sh(repo, 'show', '--format=', '--name-only', 'HEAD')).toBe(dash);

    writeFileSync(join(repo, 'README.md'), 'staged\n');
    await stagePaths(repo, repo, ['README.md']);
    writeFileSync(join(repo, 'README.md'), 'working\n');
    status = await gitRepositories(repo);
    expect(status.repositories[0]?.staged).toContainEqual(
      expect.objectContaining({ path: 'README.md' }),
    );
    expect(status.repositories[0]?.unstaged).toContainEqual(
      expect.objectContaining({ path: 'README.md' }),
    );

    sh(repo, 'reset', '--hard', 'HEAD');
    sh(repo, 'checkout', '-b', 'other');
    writeFileSync(join(repo, 'README.md'), 'other\n');
    sh(repo, 'commit', '-am', 'other');
    sh(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'README.md'), 'main\n');
    sh(repo, 'commit', '-am', 'main');
    expect(() => sh(repo, 'merge', 'other')).toThrow();
    status = await gitRepositories(repo);
    expect(status.repositories[0]?.conflicts).toContainEqual(
      expect.objectContaining({ path: 'README.md', status: 'conflicted' }),
    );
    writeFileSync(join(repo, 'README.md'), 'resolved\n');
    await stagePaths(repo, repo, ['README.md']);
    status = await gitRepositories(repo);
    expect(status.repositories[0]?.conflicts).toEqual([]);
  });

  it('stages and unstages more paths than a Windows command line can carry', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const names = Array.from({ length: 400 }, (_, i) => `${'deep-name-'.repeat(10)}${i}.txt`);
    for (const name of names) writeFileSync(join(repo, name), `${name}\n`);
    expect(names.join(' ').length).toBeGreaterThan(32_767);
    await stagePaths(repo, repo, names);
    expect((await gitRepositories(repo)).repositories[0]?.staged).toHaveLength(names.length);
    await unstagePaths(repo, repo, names);
    expect((await gitRepositories(repo)).repositories[0]?.staged).toEqual([]);
  });

  it('passes literal pathspecs on stdin under the Windows rules, on any host', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const paths = ['a b.txt', '-dash.txt', '[x].txt'];
    for (const name of [...paths, 'x.txt']) writeFileSync(join(repo, name), `${name}\n`);
    await withPathspecs(repo, ['--literal-pathspecs', 'add', '-A'], paths, 'win32');
    const staged = (await gitRepositories(repo)).repositories[0]?.staged.map((entry) => entry.path);
    expect(staged?.sort()).toEqual([...paths].sort()); // the decoy x.txt stays unstaged
  });

  it('reads HEAD and index independently across renames, ignored files, and nested repos', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    tracked(repo, 'old.txt', 'at head\n');
    sh(repo, 'mv', 'old.txt', 'new.txt');
    writeFileSync(join(repo, 'new.txt'), 'working rename\n');
    const renamed = await gitOriginal(repo, 'new.txt');
    expect(renamed.content).toBe('at head\n');
    expect(renamed.exists).toBe(true);

    writeFileSync(join(repo, 'untracked.txt'), 'new\n');
    expect(await gitOriginal(repo, 'untracked.txt')).toMatchObject({
      exists: false,
      tracked: false,
      ignored: false,
    });
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\nbrain/\n');
    writeFileSync(join(repo, 'ignored.txt'), 'ignored\n');
    expect(await gitOriginal(repo, 'ignored.txt')).toMatchObject({ ignored: true, exists: false });

    writeFileSync(join(repo, 'index.txt'), 'working\n');
    await stagePaths(repo, repo, ['index.txt']);
    writeFileSync(join(repo, 'index.txt'), 'after index\n');
    expect(await indexFile(repo, 'index.txt')).toMatchObject({
      exists: true,
      content: 'working\n',
    });

    const nested = join(repo, 'brain');
    execFileSync('git', ['init', '-b', 'main', nested]);
    sh(nested, 'config', 'user.email', 'nested@example.com');
    sh(nested, 'config', 'user.name', 'nested');
    tracked(nested, 'inside.txt', 'nested head\n');
    writeFileSync(join(nested, 'inside.txt'), 'nested working\n');
    expect(await gitOriginal(repo, 'brain/inside.txt')).toMatchObject({
      repository: realpathSync(nested),
      repository_path: 'inside.txt',
      content: 'nested head\n',
    });
  });

  // Git for Windows records symlinks only with core.symlinks and a privileged account.
  it.skipIf(process.platform === 'win32')(
    'uses the resolved target for a symlinked editor baseline',
    async () => {
      const repo = initRepo();
      cleanup.push(repo);
      writeFileSync(join(repo, 'CLAUDE.md'), 'target at head\n');
      symlinkSync('CLAUDE.md', join(repo, 'AGENTS.md'));
      sh(repo, 'add', 'CLAUDE.md', 'AGENTS.md');
      sh(repo, 'commit', '-m', 'add linked instructions');
      writeFileSync(join(repo, 'CLAUDE.md'), 'working target\n');

      // Git stores the link itself as its target-path text, but the editor reads
      // through it. The gutter baseline must therefore come from CLAUDE.md.
      expect(sh(repo, 'show', 'HEAD:AGENTS.md')).toBe('CLAUDE.md');
      expect(await gitOriginal(repo, 'AGENTS.md')).toMatchObject({
        repository: realpathSync(repo),
        repository_path: 'CLAUDE.md',
        content: 'target at head\n',
        exists: true,
        tracked: true,
        ignored: false,
      });
    },
  );

  // Git for Windows records symlinks only with core.symlinks and a privileged account.
  it.skipIf(process.platform === 'win32')(
    'omits the editor baseline when a symlink target is outside a discovered repository',
    async () => {
      const repo = initRepo();
      const outside = mkdtempSync(join(tmpdir(), 'puddle-linked-file-'));
      cleanup.push(repo, outside);
      const target = join(outside, 'shared.txt');
      writeFileSync(target, 'outside\n');
      symlinkSync(target, join(repo, 'shared.txt'));
      sh(repo, 'add', 'shared.txt');
      sh(repo, 'commit', '-m', 'add external link');

      expect(await gitOriginal(repo, 'shared.txt')).toMatchObject({
        repository: null,
        repository_path: null,
        content: null,
        exists: false,
        tracked: false,
        ignored: false,
      });
    },
  );

  it('treats an unborn repository as entirely added and can unstage it', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'puddle-unborn-'));
    cleanup.push(repo);
    sh(repo, 'init', '-b', 'main');
    sh(repo, 'config', 'user.email', 'unborn@example.com');
    sh(repo, 'config', 'user.name', 'unborn');
    writeFileSync(join(repo, 'first.txt'), 'first\n');
    await stagePaths(repo, repo, ['first.txt']);
    const result = await gitRepositories(repo);
    expect(result.repositories[0]).toMatchObject({ head: null, branch: 'main' });
    expect(result.repositories[0]?.staged).toContainEqual(
      expect.objectContaining({ path: 'first.txt', status: 'added' }),
    );
    expect(await gitOriginal(repo, 'first.txt')).toMatchObject({ head: null, exists: false });
    await unstagePaths(repo, repo, ['first.txt']);
    expect((await gitRepositories(repo)).repositories[0]?.staged).toEqual([]);
    await commitRepository(repo, repo, 'first commit', true);
    expect(sh(repo, 'show', 'HEAD:first.txt')).toBe('first');
  });
});

describe('local bare-remote operations', () => {
  it('fetches, fast-forward pulls, and pushes through the serialised mutation path', async () => {
    const seed = initRepo();
    const remote = mkdtempSync(join(tmpdir(), 'puddle-bare-'));
    cleanup.push(seed, remote);
    execFileSync('git', ['clone', '--bare', seed, remote]);
    const local = cloneRepo(remote);
    const peer = cloneRepo(remote);
    cleanup.push(local, peer);

    commitFile(peer, 'peer.txt', 'peer\n');
    sh(peer, 'push');
    await fetchRepository(local, local);
    expect((await gitRepositories(local)).repositories[0]?.behind).toBe(1);
    await pullRepository(local, local);
    expect(sh(local, 'show', 'HEAD:peer.txt')).toBe('peer');

    commitFile(local, 'local.txt', 'local\n');
    await pushRepository(local, local, false);
    expect(sh(remote, 'show', 'HEAD:local.txt')).toBe('local');
  });
});
