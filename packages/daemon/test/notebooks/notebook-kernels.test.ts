import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { NOTEBOOK_BRIDGE } from '../../src/notebooks/bridge.js';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import type { RepoStore } from '../../src/db/stores/repos.js';
import type { SessionStore } from '../../src/db/stores/sessions.js';
import { NO_SESSION } from '../../src/http/routes/worktrees/worktree-shared.js';
import { NotebookKernels } from '../../src/notebooks/kernels.js';
import { CodeProvider } from '../../src/code/provider.js';
import { findCodeExecutable } from '../../src/code/discovery.js';
import { CODE_RECIPES } from '../../src/code/recipes.js';
import { runCompilationCommand } from '../../src/compilation/process.js';

// Integration with installed Jupyter, without starting puddled or a server.
// Minimal CI hosts skip it; the ordinary provider suite uses deterministic runners.
it.skipIf(!findCodeExecutable(['jupyter-nbconvert']))(
  'executes in the selected venv without a global nbconvert executable',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-python-kernel-')));
    const executable = findCodeExecutable(['jupyter-nbconvert'])!;
    const python =
      /^#!(\S*python\S*)/.exec(readFileSync(executable, 'utf8'))?.[1] ??
      findCodeExecutable(['python3', 'python'])!;
    const deps = { sessions: {} as SessionStore, repos: {} as RepoStore };
    const kernels = new NotebookKernels(deps);
    onTestFinished(async () => {
      await kernels.dispose();
      rmSync(root, { recursive: true, force: true });
    });
    await runCompilationCommand({
      file: python,
      args: ['-m', 'venv', '--without-pip', '--system-site-packages', join(root, 'custom env')],
      cwd: root,
    });
    const source = { session: NO_SESSION, root, path: 'environment.ipynb' };
    writeFileSync(
      join(root, source.path),
      JSON.stringify({
        cells: [
          {
            id: 'python',
            cell_type: 'code',
            metadata: {},
            source: 'import sys\nprint(sys.prefix)',
            outputs: [],
            execution_count: null,
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
    );
    const selected = await kernels.action({
      source,
      action: 'select-python',
      python: 'custom env',
    });
    expect(selected).toMatchObject({
      state: 'idle',
      environment: {
        python: join(root, 'custom env/bin/python'),
        ipykernel: true,
        nbconvert: true,
      },
    });
    const provider = new CodeProvider(
      CODE_RECIPES.find((recipe) => recipe.id === 'notebook')!,
      { ...deps, notebooks: kernels, discover: () => null },
    );
    const result = await provider.run(source, { mode: 'on_demand', command: null });
    const file = result.artifacts[0]!.file;
    expect(
      JSON.parse(readFileSync(join(file.root!, file.path), 'utf8')).cells[0].outputs[0].text.join(
        '',
      ),
    ).toBe(join(root, 'custom env') + '\n');
    await kernels.action({ source, action: 'shutdown' });
    expect(await kernels.action({ source, action: 'restart' })).toMatchObject({
      state: 'idle',
      environment: { python: selected.environment!.python },
    });
  },
  30_000,
);

it.skipIf(!findCodeExecutable(['jupyter-nbconvert']))(
  'retains kernel state across runs, interrupts, restarts and shuts down cleanly',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'puddle-notebook-kernel-'));
    const deps = { sessions: {} as SessionStore, repos: {} as RepoStore };
    const kernels = new NotebookKernels(deps);
    onTestFinished(async () => {
      await kernels.dispose();
      rmSync(root, { recursive: true, force: true });
    });
    const provider = new CodeProvider(
      CODE_RECIPES.find((recipe) => recipe.id === 'notebook')!,
      { ...deps, notebooks: kernels },
    );
    const source = { session: NO_SESSION, root, path: 'counter.ipynb' };
    const setCode = (code: string, path = source.path) =>
      writeFileSync(
        join(root, path),
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {
            kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
          },
          cells: [
            {
              id: 'counter',
              cell_type: 'code',
              metadata: {},
              source: code,
              outputs: [],
              execution_count: null,
            },
          ],
        }),
      );
    const run = async (path = source.path) => {
      const result = await provider.run({ ...source, path }, { mode: 'on_demand', command: null });
      const file = result.artifacts[0]!.file;
      return JSON.parse(readFileSync(join(file.root!, file.path), 'utf8'));
    };
    const waitFor = async (state: string) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await kernels.status(source)).state === state) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        `Kernel did not become ${state}: ${JSON.stringify(await kernels.status(source))}`,
      );
    };
    expect((await kernels.catalogue()).kernels.some((kernel) => kernel.name === 'python3')).toBe(
      true,
    );
    setCode('counter = globals().get("counter", 0) + 1\nprint(counter)');
    expect((await run()).cells[0].outputs[0].text).toEqual(['1\n']);
    expect((await kernels.status(source)).state).toBe('idle');
    const second = await run();
    expect(second.cells[0].outputs[0].text).toEqual(['2\n']);
    expect(second.cells[0].execution_count).toBe(2);
    setCode('print(globals().get("counter", 0))', 'other.ipynb');
    expect((await run('other.ipynb')).cells[0].outputs[0].text).toEqual(['0\n']);

    setCode('while True:\n    pass');
    const running = run().catch((error: unknown) => error);
    await waitFor('busy');
    await kernels.action({ source, action: 'interrupt' });
    expect(await running).toBeInstanceOf(Error);
    await waitFor('idle');
    setCode('print(counter)');
    expect((await run()).cells[0].outputs[0].text).toEqual(['2\n']);

    setCode('print("x" * (3 * 1024 * 1024))');
    await expect(run()).rejects.toThrow(/output exceeded/);
    setCode('print(counter)');
    expect((await run()).cells[0].outputs[0].text).toEqual(['2\n']);

    await kernels.action({ source, action: 'restart' });
    setCode('print(globals().get("counter", 0))');
    expect((await run()).cells[0].outputs[0].text).toEqual(['0\n']);
    await kernels.action({ source, action: 'shutdown' });
    expect((await kernels.status(source)).state).toBe('stopped');
    expect((await run()).cells[0].outputs[0].text).toEqual(['0\n']);
    setCode('import os\nos._exit(0)');
    await expect(run()).rejects.toThrow();
    await waitFor('dead');
    await expect(run()).rejects.toThrow(/Restart/);
    await kernels.action({ source, action: 'restart' });
    expect((await kernels.status(source)).state).toBe('idle');
    setCode('while True:\n    pass');
    const stopping = run().catch((error: unknown) => error);
    await waitFor('busy');
    await kernels.action({ source, action: 'shutdown' });
    expect(await stopping).toBeInstanceOf(Error);
    expect((await kernels.status(source)).state).toBe('stopped');
    // Shutdown during discovery must not leave a late-started kernel behind.
    const starting = run().catch((error: unknown) => error);
    await waitFor('starting');
    await kernels.dispose();
    expect(await starting).toBeInstanceOf(Error);
    expect((await kernels.status(source)).state).toBe('stopped');
  },
  90_000,
);

it.skipIf(!findCodeExecutable(['jupyter-nbconvert'])).each(['ready', 'starting'] as const)(
  'stops a %s kernel when its daemon pipe disappears',
  async (phase) => {
    const executable = findCodeExecutable(['jupyter-nbconvert'])!;
    const python =
      /^#!(\S*python\S*)/.exec(readFileSync(executable, 'utf8'))?.[1] ??
      findCodeExecutable(['python3', 'python'])!;
    const root = mkdtempSync(join(tmpdir(), 'puddle-kernel-eof-'));
    const kernelDirectory = join(root, 'share', 'kernels', 'slow');
    mkdirSync(kernelDirectory, { recursive: true });
    writeFileSync(
      join(kernelDirectory, 'kernel.json'),
      JSON.stringify({
        argv: [python, '-c', 'import time; time.sleep(120)', '{connection_file}'],
        display_name: 'Slow startup',
        language: 'python',
      }),
    );
    const child = spawn(python, ['-u', '-c', NOTEBOOK_BRIDGE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, JUPYTER_PATH: join(root, 'share') },
    });
    const exited = once(child, 'exit');
    let pid: number | null = null;
    let ready = false;
    let catalogue = false;
    let output = '';
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (;;) {
        const end = output.indexOf('\n');
        if (end < 0) return;
        const message = JSON.parse(output.slice(0, end)) as { event?: string; pid?: number };
        output = output.slice(end + 1);
        if (message.event === 'catalogue') catalogue = true;
        if (message.event === 'spawned') pid = message.pid ?? null;
        if (message.event === 'ready') ready = true;
      }
    });
    onTestFinished(() => {
      child.stdin.end();
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        if (pid) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* Already stopped. */
          }
        }
      }
      rmSync(root, { recursive: true, force: true });
    });
    const wait = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        if (child.exitCode !== null) throw new Error(errors || 'Bridge exited');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(errors || 'Bridge did not respond');
    };
    await wait(() => catalogue);
    child.stdin.write(
      JSON.stringify({
        id: 1,
        op: 'start',
        cwd: root,
        kernel: phase === 'ready' ? 'python3' : 'slow',
      }) + '\n',
    );
    await wait(() => (phase === 'ready' ? ready : pid !== null));
    expect(pid).toBeTypeOf('number');
    // No shutdown message: this is the EOF a dead daemon leaves behind.
    child.stdin.end();
    await exited;
    expect(() => process.kill(pid!, 0)).toThrow();
  },
  20_000,
);
