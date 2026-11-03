import { NOTEBOOK_INTELLIGENCE_BRIDGE } from './intelligence-bridge.js';
import { NOTEBOOK_CELL_BRIDGE } from './cell-bridge.js';
import { NOTEBOOK_WIDGET_BRIDGE } from './widget-bridge.js';

/**
 * Installed Jupyter owns wire messages and language kernels. This small private
 * bridge keeps its KernelManager alive independently of notebook executions.
 * Passed to Python with -c: no generated module or shell command.
 */
export const NOTEBOOK_BRIDGE = String.raw`
import asyncio, json, os, signal, sys, tempfile
from pathlib import Path
import nbformat
from jupyter_client import AsyncKernelManager
from jupyter_client.kernelspec import KernelSpecManager
from nbconvert.nbconvertapp import NbConvertApp
from nbclient import NotebookClient

LIMIT = 5 * 1024 * 1024
manager = None
client = None
execution = None
interrupted = False
closing = False
kernel_name = None
runtime = tempfile.TemporaryDirectory(prefix='puddle-kernel-')
spec_manager = KernelSpecManager()
if '--puddle-python' in sys.argv[1:]:
    # A private spec pins the selected interpreter even if a user-level python3
    # spec points elsewhere. Never register or overwrite a host kernelspec.
    specs = Path(runtime.name) / 'kernels'
    spec = specs / 'python3'
    spec.mkdir(parents=True)
    (spec / 'kernel.json').write_text(json.dumps({
        'argv': [sys.executable, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
        'display_name': 'Python 3', 'language': 'python',
    }))
    spec_manager = KernelSpecManager(kernel_dirs=[str(specs)], ensure_native_kernel=False)

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

def catalogue():
    specs = spec_manager.get_all_specs()
    return [{"name": name, "display_name": data['spec'].get('display_name') or name,
             "language": data['spec'].get('language', '')} for name, data in specs.items()]

class BoundedClient(NotebookClient):
    output_bytes = 0
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.kc = client
        self.widget_registry = {'@jupyter-widgets/output': {'OutputModel': PassiveOutput}}
        if widget_collector is not None:
            for comm_id, state in widget_collector.widget_state.items():
                if state.get('_model_module') == '@jupyter-widgets/output' and state.get('_model_name') == 'OutputModel':
                    self.widget_state[comm_id] = dict(state)
                    self.comm_objects[comm_id] = PassiveOutput(comm_id, dict(state), self.kc, self)

    def process_message(self, msg, cell, cell_index):
        self.output_bytes += len(json.dumps(msg.get('content', {}), default=str).encode())
        if self.output_bytes > 2 * 1024 * 1024:
            raise RuntimeError('Notebook output exceeded 2 MiB')
        return super().process_message(msg, cell, cell_index)

async def start(name, cwd):
    global manager, client, kernel_name
    if manager is not None:
        if not await manager.is_alive():
            raise RuntimeError('The kernel exited. Restart it before running again.')
        if name != kernel_name:
            raise RuntimeError('Select or restart the kernel to change its language.')
        return
    kernel_name = name
    manager = AsyncKernelManager(kernel_name=name, kernel_spec_manager=spec_manager, connection_file=str(Path(runtime.name) / 'kernel.json'))
    await asyncio.wait_for(manager.start_kernel(cwd=cwd, stdout=sys.stderr, stderr=sys.stderr), timeout=30)
    pid = getattr(manager.provisioner, 'pid', None)
    emit({'event': 'spawned', **({'pid': pid} if isinstance(pid, int) else {})})
    client = manager.client()
    client.start_channels()
    await client.wait_for_ready(timeout=30)
    await start_widgets()
    emit({'event': 'ready', 'kernel': name})

async def run(message):
    global interrupted
    interrupted = False
    try:
        source = Path(message['source'])
        with source.open('rb') as handle:
            raw = handle.read(LIMIT + 1)
        if len(raw) > LIMIT:
            raise RuntimeError('Notebook exceeds the 5 MiB editor limit')
        nb = nbformat.reads(raw.decode('utf-8'), as_version=4)
        if len(nb.cells) > 2000:
            raise RuntimeError('Notebook exceeds 2,000 cells')
        app = NbConvertApp()
        app.parse_command_line(message['args'])
        if app.extra_args != [str(source)] or app.export_format != 'notebook':
            raise RuntimeError('Notebook commands must use --to notebook and execute {{source}}')
        if app.output_base != 'notebook.ipynb' or str(Path(app.config.FilesWriter.get('build_directory', '')).resolve()) != str(Path(message['output']).parent.resolve()):
            raise RuntimeError('Notebook commands must retain --output notebook.ipynb --output-dir {{output_dir}}')
        config = app.config
        # The existing command fields continue to accept nbconvert execution
        # options. Puddle always owns the notebook output path and kernel lifetime.
        config.NotebookClient.update(dict(config.get('ExecutePreprocessor', {})))
        name = message.get('kernel') or config.NotebookClient.get('kernel_name') or nb.metadata.get('kernelspec', {}).get('name') or 'python3'
        await start(name, message.get('cwd', str(source.parent)))
        config.NotebookClient.shutdown_kernel = 'graceful'
        runner = BoundedClient(nb, km=manager, config=config)
        runner.kc = client
        runner.allow_errors = False
        runner.allow_error_names = []
        runner.kc.allow_stdin = False
        runner.record_timing = False
        if runner.timeout is None or runner.timeout < 0:
            runner.timeout = 120
        # Using the externally owned client avoids nbclient's cleanup context:
        # only explicit lifecycle commands below can stop this kernel.
        for index, cell in enumerate(nb.cells):
            if interrupted:
                raise RuntimeError('Notebook execution interrupted')
            await runner.async_execute_cell(cell, index)
        if interrupted:
            raise RuntimeError('Notebook execution interrupted')
        # Executed copies retain the same widget graph as live previews.
        if widget_collector is not None:
            runner.widget_state = widget_collector.widget_state
            runner.widget_buffers = widget_collector.widget_buffers
        runner.set_widgets_metadata()
        encoded = nbformat.writes(nb).encode('utf-8')
        if len(encoded) > LIMIT:
            raise RuntimeError('Executed notebook exceeds the 5 MiB editor limit')
        Path(message['output']).write_bytes(encoded)
        emit({'id': message['id'], 'ok': True})
    except BaseException as error:
        if isinstance(error, asyncio.CancelledError):
            raise
        if manager is not None:
            try:
                await manager.interrupt_kernel()
            except Exception:
                pass
        if manager is not None and not await manager.is_alive():
            emit({'event': 'dead', 'error': 'The kernel exited. Restart it before running again.'})
        emit({'id': message['id'], 'error': str(error)[-32768:] or type(error).__name__})

async def shutdown():
    global manager, client, closing, interrupted
    closing = True
    if widget_task is not None:
        widget_task.cancel()
        await asyncio.gather(widget_task, return_exceptions=True)
    if widget_client is not None:
        widget_client.stop_channels()
    interrupted = True
    if execution is not None and not execution.done():
        execution.cancel()
        await asyncio.gather(execution, return_exceptions=True)
    if manager is not None:
        try:
            await manager.shutdown_kernel(now=True)
        except Exception:
            pass
    if client is not None:
        client.stop_channels()
    manager = None
    emit({'event': 'stopped'})
    try:
        runtime.cleanup()
    except OSError:
        # A kernel that is still exiting may hold its connection file on Windows.
        if sys.platform != 'win32':
            raise

async def monitor():
    while not closing:
        await asyncio.sleep(1)
        if manager is not None and manager.has_kernel and not await manager.is_alive():
            emit({'event': 'dead', 'error': 'The kernel exited. Restart it before running again.'})
            return

async def start_request(message):
    try:
        await start(message['kernel'], message['cwd'])
        emit({'id': message['id'], 'ok': True})
    except Exception as error:
        emit({'id': message['id'], 'error': str(error)})

${NOTEBOOK_CELL_BRIDGE}
${NOTEBOOK_INTELLIGENCE_BRIDGE}
${NOTEBOOK_WIDGET_BRIDGE}

async def main():
    global execution, interrupted, input_pending
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, lambda: asyncio.create_task(shutdown()))
        except NotImplementedError:
            pass
    emit({'event': 'catalogue', 'kernels': catalogue()})
    monitor_task = asyncio.create_task(monitor())
    while not closing:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        if len(line.encode('utf-8')) > 2 * 1024 * 1024:
            raise RuntimeError('Kernel request exceeds its size limit')
        message = json.loads(line)
        op = message['op']
        if op == 'shutdown':
            break
        if op == 'interrupt':
            interrupted = True
            try:
                if manager is not None and manager.has_kernel:
                    await manager.interrupt_kernel()
                emit({'id': message['id'], 'ok': True})
            except Exception as error:
                emit({'id': message['id'], 'error': str(error)})
        elif op == 'query':
            asyncio.create_task(query_kernel(message))
        elif op == 'widget':
            try:
                send_widget(message)
                emit({'id': message['id'], 'ok': True})
            except Exception as error:
                emit({'id': message['id'], 'error': str(error)})
        elif op == 'input':
            if input_pending is None or input_pending['key'] != (message.get('run_id'), message.get('input_id')):
                emit({'id': message['id'], 'error': 'This input request is no longer active'})
            else:
                try:
                    input_pending['runner'].reply_input(input_pending['cell_index'], input_pending['prompt'], message['value'])
                    input_pending = None
                    emit({'event': 'input-cleared', 'run_id': message['run_id']})
                    emit({'id': message['id'], 'ok': True})
                except Exception as error:
                    await manager.interrupt_kernel()
                    emit({'id': message['id'], 'error': str(error)})
        elif op == 'cells':
            if execution is not None and not execution.done():
                emit({'id': message['id'], 'error': 'This notebook is already running'})
            else:
                execution = asyncio.create_task(run_cells(message))
        elif op == 'start':
            execution = asyncio.create_task(start_request(message))
        elif op == 'run':
            if execution is not None and not execution.done():
                emit({'id': message['id'], 'error': 'This notebook is already running'})
            else:
                execution = asyncio.create_task(run(message))
    monitor_task.cancel()
    await shutdown()

try:
    asyncio.run(main())
except BaseException as error:
    print(str(error), file=sys.stderr, flush=True)
    raise
`;
