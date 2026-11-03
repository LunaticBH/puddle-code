import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { NotebookEnvironments } from '../../src/notebooks/environments.js';
import { CompilationCommandError, type CompilationCommand } from '../../src/compilation/process.js';
import { NotebookKernels } from '../../src/notebooks/kernels.js';
import type { SessionStore } from '../../src/db/stores/sessions.js';
import type { RepoStore } from '../../src/db/stores/repos.js';
import { NO_SESSION } from '../../src/http/routes/worktrees/worktree-shared.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-python-')));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const python = (relative: string) => {
    const path = join(root, relative, 'bin/python');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o700);
    return path;
  };
  return { root, python };
}

it('discovers project venvs, Conda/Mamba environments and custom Conda locations without ipykernel', async () => {
  const f = fixture();
  const paths = [
    'project/.venv',
    'miniconda3',
    'miniconda3/envs/data',
    'micromamba/envs/main',
    'custom env',
  ];
  const expected = paths.map(f.python);
  mkdirSync(join(f.root, 'project/notebooks'));
  mkdirSync(join(f.root, '.conda'));
  writeFileSync(join(f.root, '.conda/environments.txt'), join(f.root, 'custom env') + '\n');
  const runner = vi.fn(async () => ({
    exitCode: 0,
    stdout: '{"ipykernel":false,"nbconvert":false}',
    stderr: '',
  }));
  const environments = new NotebookEnvironments(f.root, { PATH: '' }, runner);
  const source = join(f.root, 'project/notebooks/new.ipynb');
  const discovered = await environments.discover(source, join(f.root, 'project'));
  expect(discovered.map((item) => item.python)).toEqual(expect.arrayContaining(expected));
  expect(discovered.find((item) => item.python === expected[0])).toMatchObject({
    ipykernel: false,
    nbconvert: false,
  });
  const calls = runner.mock.calls.length;
  await environments.discover(source, join(f.root, 'project'));
  expect(runner).toHaveBeenCalledTimes(calls);
});

it('resolves user paths without collapsing venv symlinks or interpreting shell syntax', async () => {
  const f = fixture();
  const base = f.python('base');
  const venv = join(f.root, 'project/.venv/bin/python');
  mkdirSync(dirname(venv), { recursive: true });
  symlinkSync(base, venv);
  const environments = new NotebookEnvironments(f.root, { PATH: '' });
  expect(await environments.resolvePython('.venv', join(f.root, 'project'))).toBe(venv);
  expect(await environments.resolvePython('~/project/.venv', f.root)).toBe(venv);
  expect(await environments.resolvePython(venv, f.root)).toBe(venv);
  await expect(environments.resolvePython('$(touch wrong)', f.root)).rejects.toThrow();
});

it('installs only missing packages in the exact environment and verifies the result', async () => {
  const f = fixture();
  const python = f.python('environment with spaces');
  let installed = false;
  const runner = vi.fn(async (command: CompilationCommand) => {
    if (command.args[0] === '-m') installed = true;
    return {
      exitCode: 0,
      stdout: JSON.stringify({ ipykernel: installed, nbconvert: true }),
      stderr: '',
    };
  });
  const environments = new NotebookEnvironments(f.root, { PATH: '' }, runner);
  expect((await environments.inspect(python)).ipykernel).toBe(false);
  expect(runner.mock.calls.every(([command]) => command.args[0] === '-c')).toBe(true);
  expect(await environments.install(python)).toMatchObject({
    python,
    ipykernel: true,
    nbconvert: true,
  });
  expect(runner).toHaveBeenCalledWith(
    expect.objectContaining({
      file: python,
      args: ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'ipykernel'],
    }),
  );
});

it('keeps an incomplete selection visible without installing and surfaces pip errors', async () => {
  const f = fixture();
  const python = f.python('.venv');
  writeFileSync(join(f.root, 'new.ipynb'), '{}');
  const runner = vi.fn(async (command: CompilationCommand) => {
    if (command.args[0] === '-m')
      throw new CompilationCommandError('Install failed', command, {
        exitCode: 1,
        stdout: '',
        stderr: 'No module named pip',
      });
    return { exitCode: 0, stdout: '{"ipykernel":false,"nbconvert":false}', stderr: '' };
  });
  const environments = new NotebookEnvironments(f.root, { PATH: '' }, runner);
  const kernels = new NotebookKernels(
    { sessions: {} as SessionStore, repos: {} as RepoStore },
    environments,
  );
  onTestFinished(() => kernels.dispose());
  const source = { session: NO_SESSION, root: f.root, path: 'new.ipynb' };
  expect(await kernels.action({ source, action: 'select-python', python: '.venv' })).toMatchObject({
    state: 'stopped',
    environment: { python, ipykernel: false },
  });
  expect(runner.mock.calls.every(([command]) => command.args[0] === '-c')).toBe(true);
  await expect(
    kernels.action({ source, action: 'install-python', python: '/different/python' }),
  ).rejects.toMatchObject({ code: 'notebook_environment_changed' });
  expect(runner.mock.calls.every(([command]) => command.args[0] === '-c')).toBe(true);
  await expect(kernels.action({ source, action: 'install-python', python })).rejects.toThrow(
    'No module named pip',
  );
  await expect(
    kernels.action({ source, action: 'select-python', python: 'missing' }),
  ).rejects.toMatchObject({ status: 422, code: 'notebook_kernel_failed' });
  expect(await kernels.status(source)).toMatchObject({
    environment: { python, ipykernel: false },
    error: 'No module named pip',
  });
});
