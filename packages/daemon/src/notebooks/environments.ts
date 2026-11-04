import { constants } from 'node:fs';
import { access, open, opendir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { NotebookEnvironment } from '@puddle/shared';
import { getEnv } from '@puddle/shared/node/platform';
import { codeSearchDirectories, findCodeExecutable } from '../code/discovery.js';
import {
  CompilationCommandError,
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../compilation/process.js';
import { KeyedMutex } from '../git/mutex.js';
import { isWindowsPython, pythonEnvironment } from './python-env.js';

const probe = `import importlib.util, json
print(json.dumps({name: importlib.util.find_spec(name) is not None for name in ('ipykernel', 'nbconvert')}))`;
const packagesSchema = z.object({ ipykernel: z.boolean(), nbconvert: z.boolean() });

/** Where an environment directory keeps its interpreter, most likely first. */
const POSIX_LAYOUT = ['bin/python', 'bin/python3', 'Scripts/python.exe', 'python.exe'];
/** venvs use Scripts, Conda prefixes and python.org installs the root, MSYS2 venvs bin. */
const WINDOWS_LAYOUT = [join('Scripts', 'python.exe'), 'python.exe', join('bin', 'python.exe')];

/** Bounded host discovery includes Python installations without Jupyter packages. */
export class NotebookEnvironments {
  private readonly cache = new Map<string, { at: number; value: Promise<NotebookEnvironment> }>();
  private readonly installs = new KeyedMutex();
  private registered: { at: number; value: Promise<string[]> } | null = null;

  constructor(
    private readonly home = homedir(),
    private readonly env = process.env,
    private readonly runner: CompilationCommandRunner = runCompilationCommand,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async discover(source: string, root: string): Promise<NotebookEnvironment[]> {
    const candidates = new Set<string>();
    const add = async (path: string) => {
      if (candidates.size >= 32) return;
      const python = await this.resolvePython(path, dirname(source)).catch(() => null);
      if (python) candidates.add(python);
    };
    let directory = dirname(source);
    for (let depth = 0; depth < 16; depth++) {
      await add(join(directory, '.venv'));
      await add(join(directory, 'venv'));
      if (directory === root || dirname(directory) === directory) break;
      directory = dirname(directory);
    }
    for (const prefix of [this.variable('VIRTUAL_ENV'), this.variable('CONDA_PREFIX')]) {
      if (prefix) await add(prefix);
    }
    const prefixes = [
      this.variable('MAMBA_ROOT_PREFIX'),
      ...[
        'miniconda3',
        'anaconda3',
        'miniforge3',
        'mambaforge',
        'micromamba',
        'mamba',
        '.local/share/mamba',
        '.local/share/micromamba',
      ].map((name) => join(this.home, name)),
      // Windows has no root-owned equivalent of /opt: any local account may
      // create %ProgramData%\miniconda3 and plant the python.exe this probe
      // would run. An all-user Conda install is found when it registers with
      // the py launcher (PEP 514), and a user's own environments through
      // ~\.conda\environments.txt.
      ...(this.platform === 'win32'
        ? []
        : [
            '/opt/conda',
            '/opt/miniconda3',
            '/opt/anaconda3',
            '/opt/homebrew/Caskroom/miniforge/base',
          ]),
    ].filter((path): path is string => !!path);
    for (const prefix of prefixes) await add(prefix);
    for (const directory of [
      ...prefixes.map((prefix) => join(prefix, 'envs')),
      join(this.home, '.conda/envs'),
    ]) {
      try {
        const entries = await opendir(directory);
        let count = 0;
        for await (const entry of entries) {
          if (++count > 64 || candidates.size >= 32) break;
          if (entry.isDirectory() || entry.isSymbolicLink()) await add(join(directory, entry.name));
        }
      } catch {
        /* Optional installation directory. */
      }
    }
    // Conda records environments outside its installation prefix here.
    try {
      const handle = await open(join(this.home, '.conda/environments.txt'), 'r');
      try {
        const bytes = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        for (const path of bytes.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 64)) {
          if (isAbsolute(path.trim())) await add(path.trim());
        }
      } finally {
        await handle.close();
      }
    } catch {
      /* Conda is optional. */
    }
    if (this.platform === 'win32') {
      for (const python of await this.registeredPythons()) await add(python);
    }
    const names = this.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
    const searched = codeSearchDirectories(this.env, this.home, this.platform).slice(0, 64);
    for (const directory of searched) {
      for (const name of names) {
        const python = join(directory, name);
        if (await this.executable(python)) {
          await add(python);
          break;
        }
      }
    }
    const paths = [...candidates];
    const results: NotebookEnvironment[] = [];
    // Probe at most four interpreters at once; no synchronous subprocess discovery.
    for (let index = 0; index < paths.length; index += 4)
      results.push(
        ...(await Promise.all(paths.slice(index, index + 4).map((path) => this.inspect(path)))),
      );
    return results;
  }

  async resolvePython(input: string, cwd: string): Promise<string> {
    const homeRelative =
      input.startsWith('~/') || (this.platform === 'win32' && input.startsWith('~\\'));
    const path = resolve(
      cwd,
      input === '~' ? this.home : homeRelative ? join(this.home, input.slice(2)) : input,
    );
    // An interpreter file, including a Store alias, which cannot be stat'ed.
    if (this.platform === 'win32' && isWindowsPython(path)) return path;
    if ((await stat(path)).isDirectory()) {
      for (const name of this.platform === 'win32' ? WINDOWS_LAYOUT : POSIX_LAYOUT) {
        const python = join(path, name);
        if (await this.executable(python)) return python;
      }
      throw new Error(`No Python executable found in ${path}`);
    }
    if (!(await this.executable(path))) throw new Error(`Python is not executable: ${path}`);
    // Do not realpath: a venv's Python is commonly a symlink to the base interpreter.
    return path;
  }

  inspect(python: string, refresh = false): Promise<NotebookEnvironment> {
    const cached = this.cache.get(python);
    if (!refresh && cached && Date.now() - cached.at < 30_000) return cached.value;
    const value = (async () => {
      const label = `${basename(this.environmentDirectory(python))} (${basename(python)})`;
      try {
        const result = await this.runner({
          file: python,
          args: ['-c', probe],
          cwd: dirname(python),
          timeoutMs: 5000,
          maxOutputBytes: 8192,
          ...this.spawnEnvironment(python),
        });
        return { python, label, ...packagesSchema.parse(JSON.parse(result.stdout)) };
      } catch (error) {
        return { python, label, ipykernel: false, nbconvert: false, error: failure(error) };
      }
    })();
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(python, { at: Date.now(), value });
    return value;
  }

  install(python: string): Promise<NotebookEnvironment> {
    return this.installs.run(python, async () => {
      const before = await this.inspect(python, true);
      if (before.error) throw new Error(before.error);
      const missing = [!before.ipykernel && 'ipykernel', !before.nbconvert && 'nbconvert'].filter(
        (name): name is string => !!name,
      );
      if (missing.length) {
        try {
          await this.runner({
            file: python,
            args: ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...missing],
            cwd: dirname(python),
            timeoutMs: 120_000,
            maxOutputBytes: 128 * 1024,
            ...this.spawnEnvironment(python),
          });
        } catch (error) {
          throw new Error(failure(error), { cause: error });
        }
      }
      const after = await this.inspect(python, true);
      if (after.error || !after.ipykernel || !after.nbconvert)
        throw new Error(
          after.error ?? 'Installation finished but notebook packages are still unavailable',
        );
      return after;
    });
  }

  private async executable(path: string): Promise<boolean> {
    if (this.platform === 'win32') return isWindowsPython(path);
    try {
      await access(path, constants.X_OK);
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  /** `{ env }` for a Windows interpreter (UTF-8 stdio, Conda activation); nothing on POSIX. */
  private spawnEnvironment(python: string): { env?: NodeJS.ProcessEnv } {
    const env = pythonEnvironment(python, process.env, this.platform);
    return env ? { env } : {};
  }

  /**
   * The directory an interpreter names its environment after: the parent of
   * `bin` or `Scripts`, else (a Windows Conda prefix or python.org install)
   * the interpreter's own directory.
   */
  private environmentDirectory(python: string): string {
    const directory = dirname(python);
    if (this.platform !== 'win32') return dirname(directory);
    return /^(?:bin|scripts)$/i.test(basename(directory)) ? dirname(directory) : directory;
  }

  private variable(name: string): string | undefined {
    return getEnv(this.env, name, this.platform);
  }

  /**
   * Windows interpreters the py launcher knows (`py -0p`: PEP 514 registrations,
   * including python.org, Anaconda and Store installs), plus python.org's
   * per-user directories. Listed at most once per 30 s, with a bounded probe.
   */
  private registeredPythons(): Promise<string[]> {
    if (this.registered && Date.now() - this.registered.at < 30_000) return this.registered.value;
    const value = (async () => {
      const found: string[] = [];
      const localAppData = this.variable('LOCALAPPDATA');
      if (localAppData) {
        const root = join(localAppData, 'Programs', 'Python');
        try {
          for (const name of (await readdir(root)).slice(0, 64))
            if (/^Python3/i.test(name)) found.push(join(root, name));
        } catch {
          /* python.org's per-user installer is optional. */
        }
      }
      const launcher = this.pythonLauncher();
      if (launcher) {
        try {
          const result = await this.runner({
            file: launcher,
            args: ['-0p'],
            cwd: dirname(launcher),
            timeoutMs: 5000,
            maxOutputBytes: 16 * 1024,
          });
          found.push(...launcherInterpreters(result.stdout));
        } catch {
          /* No registered interpreter, or a launcher too old for -0p. */
        }
      }
      return found;
    })();
    this.registered = { at: Date.now(), value };
    return value;
  }

  /** py.exe: on the search path, in the Windows directory, or python.org's per-user one. */
  private pythonLauncher(): string | null {
    const systemRoot = this.variable('SystemRoot');
    const localAppData = this.variable('LOCALAPPDATA');
    return findCodeExecutable(
      ['py'],
      [
        ...codeSearchDirectories(this.env, this.home, this.platform),
        ...(systemRoot ? [systemRoot] : []),
        ...(localAppData ? [join(localAppData, 'Programs', 'Python', 'Launcher')] : []),
      ],
      this.platform,
    );
  }
}

/**
 * Interpreter paths from `py -0p`, whose lines look like
 * ` -V:3.12 *        C:\Python312\python.exe` (older launchers: ` -3.12-64 …`).
 */
export function launcherInterpreters(listing: string): string[] {
  return listing
    .split(/\r?\n/)
    .slice(0, 64)
    .flatMap((line) => /(?:[A-Za-z]:|\\\\)\\.*\.exe/i.exec(line)?.[0] ?? []);
}

function failure(error: unknown): string {
  if (error instanceof CompilationCommandError && error.result?.stderr.trim())
    return error.result.stderr.trim().slice(-2048);
  return (error instanceof Error ? error.message : String(error)).slice(-2048);
}
