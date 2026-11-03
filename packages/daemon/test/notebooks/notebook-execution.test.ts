import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { notebookExecuteSchema } from '@puddle/shared';
import type { RepoStore } from '../../src/db/stores/repos.js';
import type { SessionStore } from '../../src/db/stores/sessions.js';
import { NO_SESSION } from '../../src/http/routes/worktrees/worktree-shared.js';
import { NotebookKernels } from '../../src/notebooks/kernels.js';
import { findCodeExecutable } from '../../src/code/discovery.js';

it('bounds submissions and rejects ambiguous cell identities', () => {
  const source = { session: NO_SESSION, root: '/project', path: 'example.ipynb' };
  expect(
    notebookExecuteSchema.safeParse({
      source,
      cells: [
        { id: 'same', source: '1' },
        { id: 'same', source: '2' },
      ],
    }).success,
  ).toBe(false);
  expect(
    notebookExecuteSchema.safeParse({
      source,
      cells: [{ id: 'large', source: 'x'.repeat(1024 * 1024 + 1) }],
    }).success,
  ).toBe(false);
  expect(notebookExecuteSchema.safeParse({ source, cells: [] }).success).toBe(false);
});

// A real Jupyter kernel, without starting puddled or inheriting an agent PTY.
it.skipIf(!findCodeExecutable(['jupyter-nbconvert']))(
  'streams selected cells, keeps kernel state, handles input and stops batches on error or interruption',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-notebook-live-')));
    const source = { session: NO_SESSION, root, path: 'example.ipynb' };
    writeFileSync(
      join(root, source.path),
      JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }),
    );
    const kernels = new NotebookKernels({ sessions: {} as SessionStore, repos: {} as RepoStore });
    onTestFinished(async () => {
      await kernels.dispose();
      rmSync(root, { recursive: true, force: true });
    });
    const status = async () => (await kernels.executionStatus(source)).execution!;
    const finished = async () => {
      await expect.poll(async () => (await status()).state, { timeout: 30000 }).not.toBe('running');
      return status();
    };
    expect(
      await kernels.intelligence({ source, kind: 'complete', code: 'val', cursor: 3 }),
    ).toMatchObject({ matches: [] });
    expect((await kernels.status(source)).state).toBe('stopped');
    await kernels.executeCells({
      source,
      cells: [
        {
          id: 'setup',
          source: 'value = 41\nprint("early ✓", flush=True)\nimport time\ntime.sleep(2)',
        },
        { id: 'answer', source: 'print(value + 1)' },
      ],
    });
    await expect(
      kernels.executeCells({ source, cells: [{ id: 'overlap', source: '1' }] }),
    ).rejects.toThrow(/already running/);
    await expect
      .poll(async () => JSON.stringify((await status()).cells[0]?.outputs), {
        timeout: 30000,
        intervals: [100],
      })
      .toContain('early ✓');
    const first = await finished();
    expect(first.state).toBe('succeeded');
    expect(first.cells.map((cell) => cell.execution_count)).toEqual([1, 2]);
    expect(JSON.stringify(first.cells[1]!.outputs)).toContain('42');
    const code = '# 🙂\nval';
    const completion = await kernels.intelligence({
      source,
      kind: 'complete',
      code,
      cursor: [...code].length,
    });
    expect(completion.matches).toContain('value');
    expect(completion.start).toBe([...code].length - 3);
    const help = await kernels.intelligence({ source, kind: 'inspect', code: 'print', cursor: 5 });
    expect(help.documentation.toLowerCase()).toContain('print');

    await kernels.executeCells({
      source,
      cells: [{ id: 'input', source: 'name = input("Name: ")\nprint(name, value)' }],
    });
    await expect
      .poll(async () => (await status()).input?.prompt, { timeout: 10000 })
      .toBe('Name: ');
    const prompt = (await status()).input!;
    const run = await status();
    await expect(
      kernels.replyToInput({ source, run_id: first.id, input_id: prompt.id, value: 'wrong' }),
    ).rejects.toThrow(/no longer active/);
    await kernels.replyToInput({ source, run_id: run.id, input_id: prompt.id, value: 'Notebook' });
    const inputResult = await finished();
    expect(inputResult.cells[0]!.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'Name: Notebook\n' },
      { output_type: 'stream', name: 'stdout', text: 'Notebook 41\n' },
    ]);
    await kernels.executeCells({
      source,
      cells: [
        { id: 'error', source: 'print("before error")\nraise ValueError("example")' },
        { id: 'skipped', source: 'value = 0' },
      ],
    });
    const failed = await finished();
    expect(failed.state).toBe('failed');
    expect(failed.cells.map((cell) => cell.state)).toEqual(['failed', 'cancelled']);
    expect(JSON.stringify(failed.cells[0]!.outputs)).toContain('ValueError');
    await kernels.executeCells({
      source,
      cells: [
        { id: 'interrupt', source: 'print("waiting", flush=True)\ntime.sleep(60)' },
        { id: 'never', source: 'value = 0' },
      ],
    });
    await expect
      .poll(async () => JSON.stringify((await status()).cells[0]!.outputs), { timeout: 10000 })
      .toContain('waiting');
    await kernels.action({ source, action: 'interrupt' });
    expect((await finished()).state).toBe('cancelled');
    await kernels.executeCells({ source, cells: [{ id: 'retained', source: 'print(value)' }] });
    expect(JSON.stringify((await finished()).cells[0]!.outputs)).toContain('41');
    expect((await kernels.status(source)).state).toBe('idle');
  },
  60000,
);

it.skipIf(!findCodeExecutable(['jupyter-nbconvert']))(
  'retains ordered input traces across prompts and cells, masks passwords and honours output clearing',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-notebook-input-')));
    const source = { session: NO_SESSION, root, path: 'example.ipynb' };
    writeFileSync(
      join(root, source.path),
      JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }),
    );
    const kernels = new NotebookKernels({ sessions: {} as SessionStore, repos: {} as RepoStore });
    onTestFinished(async () => {
      await kernels.dispose();
      rmSync(root, { recursive: true, force: true });
    });
    const status = async () => (await kernels.executionStatus(source)).execution!;
    const finished = async () => {
      await expect.poll(async () => (await status()).state, { timeout: 30000 }).not.toBe('running');
      return status();
    };
    const reply = async (prompt: string, value: string) => {
      await expect
        .poll(async () => (await status()).input?.prompt, { timeout: 10000 })
        .toBe(prompt);
      const run = await status();
      const request = { source, run_id: run.id, input_id: run.input!.id, value };
      await kernels.replyToInput(request);
      await expect(kernels.replyToInput(request)).rejects.toThrow(/no longer active/);
    };
    await kernels.executeCells({
      source,
      cells: [
        {
          id: 'inputs',
          source: [
            'from IPython.display import display, clear_output',
            'from getpass import getpass',
            'print("before", flush=True)',
            'name = input("Name: ")',
            'display({"text/plain": "between prompts"}, raw=True)',
            'secret = getpass("Password: ")',
            'empty = input()',
            'print("after", flush=True)',
          ].join('\n'),
        },
        { id: 'next', source: 'next_value = input("Next cell: ")' },
      ],
    });
    await reply('Name: ', 'Notebook ✓');
    await reply('Password: ', 'private value');
    await reply('', '');
    await reply('Next cell: ', 'second');
    const result = await finished();
    expect(result.state).toBe('succeeded');
    expect(result.cells[0]!.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'before\n' },
      { output_type: 'stream', name: 'stdout', text: 'Name: Notebook ✓\n' },
      { output_type: 'display_data', metadata: {}, data: { 'text/plain': 'between prompts' } },
      { output_type: 'stream', name: 'stdout', text: 'Password: ••••••••\n' },
      { output_type: 'stream', name: 'stdout', text: '\n' },
      { output_type: 'stream', name: 'stdout', text: 'after\n' },
    ]);
    expect(result.cells[1]!.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'Next cell: second\n' },
    ]);
    expect(JSON.stringify(result)).not.toContain('private value');

    for (const wait of ['False', 'True']) {
      await kernels.executeCells({
        source,
        cells: [
          {
            id: 'clear',
            source: `old = input("Old: ")\nclear_output(wait=${wait})\nnew = input("New: ")`,
          },
        ],
      });
      await reply('Old: ', 'discard');
      await reply('New: ', 'retain');
      expect((await finished()).cells[0]!.outputs).toEqual([
        { output_type: 'stream', name: 'stdout', text: 'New: retain\n' },
      ]);
    }

    await kernels.executeCells({
      source,
      cells: [{ id: 'interrupt', source: 'value = input("Keep: ")\ninput("Waiting: ")' }],
    });
    await reply('Keep: ', 'accepted');
    await expect
      .poll(async () => (await status()).input?.prompt, { timeout: 10000 })
      .toBe('Waiting: ');
    await kernels.action({ source, action: 'interrupt' });
    const interrupted = await finished();
    expect(interrupted.state).toBe('cancelled');
    expect(interrupted.cells[0]!.outputs[0]).toEqual({
      output_type: 'stream',
      name: 'stdout',
      text: 'Keep: accepted\n',
    });

    await kernels.executeCells({
      source,
      cells: [
        {
          id: 'bounded',
          source: 'print("x" * (2 * 1024 * 1024 - 32768), flush=True)\ninput("Limit: ")',
        },
      ],
    });
    await expect
      .poll(async () => (await status()).input?.prompt, { timeout: 10000 })
      .toBe('Limit: ');
    const bounded = await status();
    await expect(
      kernels.replyToInput({
        source,
        run_id: bounded.id,
        input_id: bounded.input!.id,
        value: 'y'.repeat(65536),
      }),
    ).rejects.toThrow(/output exceeded 2 MiB/);
    expect(await finished()).toMatchObject({
      state: 'failed',
      error: 'Notebook output exceeded 2 MiB',
    });
    await kernels.executeCells({ source, cells: [{ id: 'reusable', source: 'print("ready")' }] });
    expect((await finished()).cells[0]!.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'ready\n' },
    ]);
  },
  60000,
);
