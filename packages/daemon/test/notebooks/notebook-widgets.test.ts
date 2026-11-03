import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import type { NotebookWidgetMessage } from '@puddle/shared';
import { NotebookWidgets } from '../../src/notebooks/widgets.js';
import { NotebookKernels } from '../../src/notebooks/kernels.js';
import { findCodeExecutable } from '../../src/code/discovery.js';
import { NO_SESSION } from '../../src/http/routes/worktrees/worktree-shared.js';
import type { SessionStore } from '../../src/db/stores/sessions.js';
import type { RepoStore } from '../../src/db/stores/repos.js';

function message(
  type: NotebookWidgetMessage['msg_type'],
  data: Record<string, unknown>,
  buffers: string[] = [],
): NotebookWidgetMessage {
  return {
    msg_id: crypto.randomUUID(),
    parent_id: '',
    msg_type: type,
    metadata: { version: '2.1.0' },
    content: { comm_id: 'model', target_name: 'jupyter.widget', data },
    buffers,
  };
}

it('retains binary traits, bounds event history and restores an exact model graph', () => {
  const widgets = new NotebookWidgets();
  widgets.receive(
    message(
      'comm_open',
      {
        state: {
          _model_name: 'ImageModel',
          _model_module: '@jupyter-widgets/controls',
          _model_module_version: '2.0.0',
        },
        buffer_paths: [['value']],
      },
      ['AQID'],
    ),
  );
  widgets.receive(message('comm_msg', { method: 'update', state: { format: 'png' } }));
  expect(widgets.snapshot({}).snapshot!.state.model!.buffers).toEqual([
    { encoding: 'base64', path: ['value'], data: 'AQID' },
  ]);
  widgets.receive(
    message('comm_msg', { method: 'update', state: {}, buffer_paths: [['value']] }, ['BAUG']),
  );
  expect(widgets.snapshot({}).snapshot!.state.model!.buffers).toEqual([
    { encoding: 'base64', path: ['value'], data: 'BAUG' },
  ]);
  const cursor = widgets.snapshot({});
  widgets.receive(message('comm_msg', { method: 'custom', content: { event: 'click' } }));
  expect(
    widgets.snapshot({ generation: cursor.generation!, after: cursor.revision }),
  ).toMatchObject({ events: [{ content: { data: { method: 'custom' } } }] });
  for (let at = 0; at < 300; at++)
    widgets.receive(message('comm_msg', { method: 'update', state: { format: 'jpeg' } }));
  expect(
    widgets.snapshot({ generation: cursor.generation!, after: cursor.revision }),
  ).toMatchObject({ snapshot: { state: { model: { state: { format: 'jpeg' } } } }, events: [] });
  widgets.receive(message('comm_close', {}));
  expect(widgets.has('model')).toBe(false);
  expect(widgets.snapshot({}).snapshot!.state).toEqual({});
});

it('reports oversized state without retaining an unbounded graph', () => {
  const widgets = new NotebookWidgets();
  widgets.receive(
    message('comm_open', {
      state: {
        _model_name: 'HTMLModel',
        _model_module: '@jupyter-widgets/controls',
        _model_module_version: '2.0.0',
        value: 'x'.repeat(2 * 1024 * 1024),
      },
    }),
  );
  expect(widgets.snapshot({})).toMatchObject({
    snapshot: { state: {} },
    error: expect.stringContaining('size limit'),
  });
});

it.skipIf(!findCodeExecutable(['jupyter-nbconvert']))(
  'runs widget callbacks after execution, synchronises binary data and rejects retired kernels',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-widgets-')));
    const source = { session: NO_SESSION, root, path: 'widgets.ipynb' };
    writeFileSync(
      join(root, source.path),
      JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }),
    );
    const kernels = new NotebookKernels({ sessions: {} as SessionStore, repos: {} as RepoStore });
    onTestFinished(async () => {
      await kernels.dispose();
      rmSync(root, { recursive: true, force: true });
    });
    const run = async (code: string) => {
      await kernels.executeCells({ source, cells: [{ id: 'cell', source: code }] });
      await expect
        .poll(async () => (await kernels.executionStatus(source)).execution!.state, {
          timeout: 30000,
        })
        .not.toBe('running');
      const result = (await kernels.executionStatus(source)).execution!;
      expect(result.state, result.error).toBe('succeeded');
      return JSON.stringify(result.cells[0]!.outputs);
    };
    await run(`import ipywidgets as w
import ipywidgets.widgets.widget as widget_protocol
widget_protocol.JUPYTER_WIDGET_ECHO = False
from IPython.display import display
slider = w.IntSlider(value=3, description='Amount')
button = w.Button(description='Increment')
out = w.Output()
image = w.Image(value=bytes([1, 2, 3]))
count = 0
def clicked(button):
    global count
    count += 1
    with out:
        print('clicked', count)
button.on_click(clicked)
display(w.VBox([slider, button, out, image]))`);
    await expect
      .poll(
        async () =>
          Object.values((await kernels.widgetState({ source })).snapshot!.state).filter(
            (model) => model.model_name === 'VBoxModel',
          ).length,
      )
      .toBe(1);
    const state = await kernels.widgetState({ source });
    const find = (name: string) =>
      Object.entries(state.snapshot!.state).find(([, model]) => model.model_name === name)![0];
    const send = (id: string, data: Record<string, unknown>, buffers: string[] = []) =>
      kernels.widgetComm({
        source,
        generation: state.generation!,
        message: {
          ...message('comm_msg', data, buffers),
          msg_type: 'comm_msg',
          content: { comm_id: id, data },
        },
      });
    await send(find('IntSliderModel'), {
      method: 'update',
      state: { value: 17 },
      buffer_paths: [],
    });
    expect(await run('print(slider.value)')).toContain('17');
    await send(find('ButtonModel'), { method: 'custom', content: { event: 'click' } });
    await expect
      .poll(
        async () =>
          JSON.stringify(
            (await kernels.widgetState({ source })).snapshot!.state[find('OutputModel')]!.state
              .outputs,
          ),
        { timeout: 10000 },
      )
      .toContain('clicked 1');
    await send(find('ImageModel'), { method: 'update', state: {}, buffer_paths: [['value']] }, [
      'BAUG',
    ]);
    expect(await run('print(list(image.value))')).toContain('[4, 5, 6]');
    // Reusing an Output widget in later cells must not leak captured text into cell output.
    expect(await run('with out:\n    print("later cell")')).not.toContain('later cell');
    await expect
      .poll(async () =>
        JSON.stringify(
          (await kernels.widgetState({ source })).snapshot!.state[find('OutputModel')]!.state
            .outputs,
        ),
      )
      .toContain('later cell');
    const captured = async () =>
      (await kernels.widgetState({ source })).snapshot!.state[find('OutputModel')]!.state.outputs;
    await run('out.append_stdout("appended\\n")');
    await expect.poll(async () => JSON.stringify(await captured())).toContain('appended');
    await run('with out:\n    handle = display("old display", display_id=True)');
    await run('handle.update("updated display")');
    await expect.poll(async () => JSON.stringify(await captured())).toContain('updated display');
    expect(JSON.stringify(await captured())).not.toContain('old display');
    await run('out.clear_output(wait=True)');
    expect(JSON.stringify(await captured())).toContain('updated display');
    await run('with out:\n    print("replacement")');
    await expect
      .poll(captured)
      .toEqual([{ output_type: 'stream', name: 'stdout', text: 'replacement\n' }]);
    writeFileSync(
      join(root, source.path),
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            id: 'copy',
            cell_type: 'code',
            metadata: {},
            source: 'display(slider)',
            outputs: [],
            execution_count: null,
          },
        ],
      }),
    );
    await kernels.execute(join(root, source.path), join(root, 'notebook.ipynb'), {
      file: findCodeExecutable(['jupyter-nbconvert'])!,
      args: [
        '--to',
        'notebook',
        '--execute',
        join(root, source.path),
        '--output',
        'notebook.ipynb',
        '--output-dir',
        root,
      ],
    });
    const copied = JSON.parse(readFileSync(join(root, 'notebook.ipynb'), 'utf8'));
    expect(
      copied.metadata.widgets['application/vnd.jupyter.widget-state+json'].state[
        find('IntSliderModel')
      ].state.value,
    ).toBe(17);
    await kernels.action({ source, action: 'restart' });
    expect((await kernels.widgetState({ source })).generation).not.toBe(state.generation);
    await expect(
      send(find('ButtonModel'), { method: 'custom', content: { event: 'click' } }),
    ).rejects.toThrow(/no longer active/);
    await kernels.action({ source, action: 'shutdown' });
    expect(await kernels.widgetState({ source })).toEqual({
      generation: null,
      revision: 0,
      events: [],
    });
  },
  60000,
);
