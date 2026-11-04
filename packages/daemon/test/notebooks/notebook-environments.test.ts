import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { getEnv } from '@puddle/shared/node/platform';
import { launcherInterpreters, NotebookEnvironments } from '../../src/notebooks/environments.js';
import { CompilationCommandError, type CompilationCommand } from '../../src/compilation/process.js';
import { NotebookKernels, programName } from '../../src/notebooks/kernels.js';
import {
  isWindowsPython,
  launcherPython,
  pythonEnvironment,
} from '../../src/notebooks/python-env.js';
import type { SessionStore } from '../../src/db/stores/sessions.js';
import type { RepoStore } from '../../src/db/stores/repos.js';
import { NO_SESSION } from '../../src/http/routes/worktrees/worktree-shared.js';

const windows = process.platform === 'win32';

/** Fake interpreters in each platform's environment layout; the runner never starts them. */
function fixture(platform: NodeJS.Platform = process.platform) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-python-')));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const python = (relative: string) => {
    const path = join(root, relative, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
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

// POSIX venvs link their interpreter; Windows venvs copy a launcher (covered below).
it.skipIf(windows)(
  'resolves user paths without collapsing venv symlinks or interpreting shell syntax',
  async () => {
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
  },
);

it('resolves Windows venvs, Conda prefixes and home paths in the Windows layout', async () => {
  const f = fixture('win32');
  const venv = f.python('project/.venv');
  const conda = join(f.root, 'miniconda3', 'python.exe');
  mkdirSync(dirname(conda));
  writeFileSync(conda, '');
  writeFileSync(join(f.root, 'project', 'python'), '#!/bin/sh\n');
  const environments = new NotebookEnvironments(f.root, { PATH: '' }, undefined, 'win32');
  expect(await environments.resolvePython('.venv', join(f.root, 'project'))).toBe(venv);
  expect(await environments.resolvePython('~/project/.venv', f.root)).toBe(venv);
  // A backslash separates only on a Windows host.
  if (windows) expect(await environments.resolvePython('~\\project\\.venv', f.root)).toBe(venv);
  expect(await environments.resolvePython('~/miniconda3', f.root)).toBe(conda);
  expect(await environments.resolvePython(venv, f.root)).toBe(venv);
  // Windows cannot start an extensionless file.
  await expect(environments.resolvePython('project/python', f.root)).rejects.toThrow();
  await expect(environments.resolvePython('$(touch wrong)', f.root)).rejects.toThrow();
});

it('never probes interpreters in Windows folders another local account could create', async () => {
  const f = fixture('win32');
  const drive = join(f.root, 'drive');
  const programData = join(f.root, 'ProgramData');
  const planted = [
    join(programData, 'miniconda3', 'python.exe'),
    join(programData, 'anaconda3', 'envs', 'x', 'python.exe'),
    join(drive, 'Python399', 'python.exe'),
  ];
  for (const path of planted) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  }
  const home = join(f.root, 'home');
  mkdirSync(join(f.root, 'project'));
  mkdirSync(home);
  const runner = vi.fn(async (_command: CompilationCommand) => ({
    exitCode: 0,
    stdout: '{"ipykernel":false,"nbconvert":false}',
    stderr: '',
  }));
  const environments = new NotebookEnvironments(
    home,
    { PATH: '', ProgramData: programData, SystemDrive: drive },
    runner,
    'win32',
  );
  const discovered = await environments.discover(
    join(f.root, 'project', 'new.ipynb'),
    join(f.root, 'project'),
  );
  expect(runner.mock.calls.map(([command]) => command.file)).toEqual([]);
  expect(discovered).toEqual([]);
});

it('lists the interpreters the Windows py launcher reports', () => {
  expect(
    launcherInterpreters(
      [
        ' -V:3.12 *        C:\\Python312\\python.exe',
        ' -V:ContinuumAnalytics/Anaconda39-64 C:\\Users\\a b\\anaconda3\\python.exe',
        ' -3.10-64         C:\\Users\\a\\AppData\\Local\\Programs\\Python\\Python310\\python.exe',
        'No Installed Pythons Found!',
      ].join('\r\n'),
    ),
  ).toEqual([
    'C:\\Python312\\python.exe',
    'C:\\Users\\a b\\anaconda3\\python.exe',
    'C:\\Users\\a\\AppData\\Local\\Programs\\Python\\Python310\\python.exe',
  ]);
});

it('runs Windows interpreters with UTF-8 stdio and their Conda prefix activated', () => {
  const f = fixture('win32');
  const prefix = join(f.root, 'anaconda3');
  mkdirSync(join(prefix, 'conda-meta'), { recursive: true });
  const base = join(prefix, 'python.exe');
  writeFileSync(base, '');
  const venv = f.python('project/.venv');
  writeFileSync(join(f.root, 'project/.venv/pyvenv.cfg'), `home = ${prefix}\nversion = 3.12.1\n`);
  const plain = f.python('plain');
  expect(pythonEnvironment(base, { PATH: '/usr/bin' }, 'linux')).toBeUndefined();
  const activated = pythonEnvironment(venv, { Path: 'C:\\Windows' }, 'win32')!;
  expect(activated).toMatchObject({ PYTHONIOENCODING: 'utf-8' });
  expect(activated.PATH).toBeUndefined();
  expect(activated.Path!.split(';')).toEqual([
    prefix,
    join(prefix, 'Library', 'mingw-w64', 'bin'),
    join(prefix, 'Library', 'usr', 'bin'),
    join(prefix, 'Library', 'bin'),
    join(prefix, 'Scripts'),
    join(prefix, 'bin'),
    'C:\\Windows',
  ]);
  expect(pythonEnvironment(plain, { Path: 'C:\\Windows' }, 'win32')!.Path).toBe('C:\\Windows');
  // A kernel's `!make html` finds make.bat beside the notebook, as in any console;
  // a value the user set themselves stays.
  const daemon = { Path: 'C:\\Windows', NoDefaultCurrentDirectoryInExePath: 'puddle' };
  expect(pythonEnvironment(plain, daemon, 'win32')).toEqual({
    Path: 'C:\\Windows',
    PYTHONIOENCODING: 'utf-8',
  });
  const own = { NoDefaultCurrentDirectoryInExePath: '1' };
  expect(pythonEnvironment(plain, own, 'win32')).toMatchObject(own);
});

it('finds the interpreter behind Windows console-script launchers', () => {
  const f = fixture('win32');
  const scripts = join(f.root, 'tools', 'Scripts');
  mkdirSync(scripts, { recursive: true });
  const python = join(f.root, 'Python 3.12', 'python.exe');
  mkdirSync(dirname(python));
  writeFileSync(python, '');
  // pip/distlib: the shebang precedes the appended zip archive.
  const distlib = join(scripts, 'jupyter-nbconvert.exe');
  writeFileSync(
    distlib,
    Buffer.concat([
      Buffer.from('MZ launcher stub\0#!not this one\0'),
      Buffer.from(`#!"${python}"\n\r\nPK\x03\x04archive`, 'latin1'),
    ]),
  );
  expect(launcherPython(distlib)).toBe(python);
  // Conda/setuptools: `<name>-script.py` beside an exe, the interpreter one level up.
  const conda = join(f.root, 'anaconda3');
  mkdirSync(join(conda, 'Scripts'), { recursive: true });
  writeFileSync(join(conda, 'python.exe'), '');
  writeFileSync(join(conda, 'Scripts', 'jupyter.exe'), 'MZ');
  writeFileSync(join(conda, 'Scripts', 'jupyter-script.py'), '# -*- coding: utf-8 -*-\n');
  expect(launcherPython(join(conda, 'Scripts', 'jupyter.exe'))).toBe(join(conda, 'python.exe'));
  // A venv keeps python.exe beside its scripts.
  const venv = f.python('venv');
  writeFileSync(join(dirname(venv), 'jupyter.exe'), 'MZ');
  expect(launcherPython(join(dirname(venv), 'jupyter.exe'))).toBe(venv);
  expect(launcherPython(join(f.root, 'missing.exe'))).toBeNull();
});

it('classifies Windows notebook commands without case or .exe', () => {
  expect(programName('C:\\venv\\Scripts\\Jupyter-NBConvert.EXE', 'win32')).toBe(
    'jupyter-nbconvert',
  );
  expect(programName('/usr/bin/Python3', 'linux')).toBe('Python3');
});

it.runIf(windows)('skips the Microsoft Store python.exe redirector stub', () => {
  const stub = join(
    getEnv(process.env, 'LOCALAPPDATA') ?? '',
    'Microsoft',
    'WindowsApps',
    'python.exe',
  );
  let target: string;
  try {
    target = readlinkSync(stub);
  } catch {
    return; // No App Installer alias on this host.
  }
  expect(isWindowsPython(stub)).toBe(!/AppInstallerPythonRedirector\.exe$/i.test(target));
  expect(isWindowsPython(process.execPath)).toBe(true);
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
