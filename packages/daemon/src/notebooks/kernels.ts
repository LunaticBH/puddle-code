import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, win32 } from 'node:path';
import {
  type CompilationFileTarget,
  type NotebookKernelAction,
  type NotebookKernelsResponse,
  type NotebookKernelStatus,
  type NotebookEnvironment,
  type NotebookEnvironmentsResponse,
} from '@puddle/shared';
import { KeyedMutex } from '../git/mutex.js';
import { ApiError } from '../http/errors.js';
import {
  containedPath,
  resolveFsRoot,
  type WorktreeDeps,
} from '../http/routes/worktrees/worktree-shared.js';
import { findCodeExecutable } from '../code/discovery.js';
import { KernelBridge } from './kernel-bridge.js';
import { NotebookExecutionController } from './execution.js';
import type {
  NotebookExecute,
  NotebookInputReply,
  NotebookIntelligenceRequest,
  NotebookIntelligenceResponse,
} from '@puddle/shared';
import { NotebookEnvironments } from './environments.js';
import { launcherPython } from './python-env.js';
import { NotebookWidgets } from './widgets.js';
import type {
  NotebookWidgetComm,
  NotebookWidgetsRequest,
  NotebookWidgetsResponse,
} from '@puddle/shared';

interface KernelEntry {
  source: string;
  executable: string;
  bridge: KernelBridge | null;
  selected: string | null;
  status: NotebookKernelStatus;
  busy: boolean;
  cancelled: boolean;
  changing: boolean;
  finished: Promise<void> | null;
  environment?: NotebookEnvironment;
  execution: NotebookExecutionController;
  querying: boolean;
  widgets: NotebookWidgets | null;
}

/** Canonical files own their kernels until explicit shutdown or daemon disposal. */
export class NotebookKernels {
  private readonly lifecycle = new KeyedMutex();
  private readonly entries = new Map<string, KernelEntry>();
  private catalogueCache: { at: number; value: NotebookKernelsResponse } | null = null;
  private catalogueBridge: KernelBridge | null = null;
  private cataloguePending: Promise<NotebookKernelsResponse> | null = null;
  private disposed = false;

  constructor(
    private readonly deps: WorktreeDeps,
    private readonly pythonEnvironments = new NotebookEnvironments(),
  ) {}

  async environments(source: CompilationFileTarget): Promise<NotebookEnvironmentsResponse> {
    const path = await this.path(source);
    const root = await realpath(resolveFsRoot(this.deps, source.session, source.root));
    const environments = await this.pythonEnvironments.discover(path, root);
    const selected = this.entries.get(path)?.environment;
    if (selected && !environments.some((environment) => environment.python === selected.python))
      environments.unshift(await this.pythonEnvironments.inspect(selected.python));
    return { environments };
  }

  async catalogue(): Promise<NotebookKernelsResponse> {
    if (this.disposed)
      return { available: false, kernels: [], error: 'Notebook kernels are closed' };
    if (this.catalogueCache && Date.now() - this.catalogueCache.at < 30_000)
      return this.catalogueCache.value;
    if (this.cataloguePending) return this.cataloguePending;
    this.cataloguePending = (async () => {
      const executable = findCodeExecutable(['jupyter-nbconvert']);
      if (!executable) return { available: false, kernels: [] };
      let bridge: KernelBridge | null = null;
      try {
        const python = await pythonFor(executable);
        if (this.disposed) throw new Error('Notebook kernels are closed');
        bridge = new KernelBridge(python);
        this.catalogueBridge = bridge;
        return { available: true, kernels: await bridge.ready };
      } catch (error) {
        return { available: false, kernels: [], error: errorMessage(error) };
      } finally {
        await bridge?.close();
        if (this.catalogueBridge === bridge) this.catalogueBridge = null;
      }
    })()
      .then((value) => {
        this.catalogueCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.cataloguePending = null;
      });
    return this.cataloguePending;
  }

  async status(source: CompilationFileTarget): Promise<NotebookKernelStatus> {
    const path = await this.path(source);
    const entry = this.entries.get(path);
    return entry
      ? { ...entry.status, ...(entry.environment ? { environment: entry.environment } : {}) }
      : { state: 'stopped', kernel: null };
  }

  async action(request: NotebookKernelAction): Promise<NotebookKernelStatus> {
    const path = await this.path(request.source);
    return this.lifecycle.run(path, async () => {
      try {
        const status = await this.changeKernel(path, request);
        const environment = this.entries.get(path)?.environment;
        return { ...status, ...(environment ? { environment } : {}) };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        const failure = new ApiError(422, 'notebook_kernel_failed', errorMessage(error));
        failure.cause = error;
        throw failure;
      }
    });
  }

  private async changeKernel(
    path: string,
    request: NotebookKernelAction,
  ): Promise<NotebookKernelStatus> {
    if (this.disposed) throw new Error('Notebook kernels are closed');
    let entry = this.entries.get(path);
    if (
      request.action === 'select-python' ||
      request.action === 'install-python' ||
      (request.action === 'restart' && entry?.environment)
    ) {
      if (request.action === 'install-python' && request.python !== entry?.environment?.python)
        throw ApiError.conflict(
          'notebook_environment_changed',
          'The selected environment changed. Select it again before installing packages.',
        );
      const python =
        request.action === 'select-python'
          ? await this.pythonEnvironments.resolvePython(request.python, dirname(path))
          : entry?.environment?.python;
      if (!python)
        throw ApiError.badRequest(
          'notebook_environment_missing',
          'Select a Python environment first',
        );
      const environment = await this.pythonEnvironments.inspect(python, true);
      if (environment.error)
        throw ApiError.badRequest('invalid_python_environment', environment.error);
      if (this.disposed) throw new Error('Notebook kernels are closed');
      entry = this.entry(path, python);
      entry.changing = true;
      try {
        await this.stop(entry);
        if (this.disposed) throw new Error('Notebook kernels are closed');
        entry.bridge = null;
        entry.environment = environment;
        entry.selected = 'python3';
        entry.status = { state: 'stopped', kernel: 'python3' };
        if (request.action === 'install-python')
          entry.environment = await this.pythonEnvironments.install(python);
        if (!entry.environment.ipykernel || !entry.environment.nbconvert) return entry.status;
        entry.status = { state: 'starting', kernel: 'python3' };
        const bridge = await this.connect(entry);
        await bridge.request({ op: 'start', kernel: 'python3', cwd: dirname(path) }, 45_000);
        entry.status = { state: 'idle', kernel: 'python3' };
      } catch (error) {
        await this.stop(entry);
        entry.bridge = null;
        entry.status = { state: 'dead', kernel: 'python3', error: errorMessage(error) };
        throw error;
      } finally {
        entry.changing = false;
      }
      return entry.status;
    }
    if (request.action === 'interrupt') {
      if (entry) entry.cancelled = true;
      if (entry?.bridge) await entry.bridge.request({ op: 'interrupt' }, 10_000);
    } else if (request.action === 'shutdown') {
      if (entry) {
        entry.changing = true;
        await this.stop(entry);
      }
      if (entry) {
        entry.bridge = null;
        entry.changing = false;
        entry.status = { state: 'stopped', kernel: entry.selected ?? entry.status.kernel };
      }
    } else {
      const catalogue = await this.catalogue();
      const name =
        request.action === 'select' ? request.kernel : (entry?.selected ?? entry?.status.kernel);
      if (name && !catalogue.kernels.some((kernel) => kernel.name === name))
        throw ApiError.badRequest(
          'notebook_kernel_missing',
          `Kernel ${name} is not installed on this host`,
        );
      const selected = name ?? catalogue.kernels[0]?.name;
      if (!selected)
        throw new ApiError(
          424,
          'notebook_kernel_missing',
          'No Jupyter kernel is installed on this host',
        );
      entry = this.entry(
        path,
        entry?.executable ?? findCodeExecutable(['jupyter-nbconvert']) ?? 'jupyter-nbconvert',
      );
      entry.changing = true;
      await this.stop(entry);
      entry.bridge = null;
      if (request.action === 'select') {
        entry.environment = undefined;
        entry.executable = findCodeExecutable(['jupyter-nbconvert']) ?? 'jupyter-nbconvert';
      }
      entry.selected = selected;
      entry.status = { state: 'starting', kernel: selected };
      try {
        const bridge = await this.connect(entry);
        await bridge.request({ op: 'start', kernel: selected, cwd: dirname(path) }, 45_000);
        entry.status = { state: 'idle', kernel: selected };
      } catch (error) {
        await this.stop(entry);
        entry.status = { state: 'dead', kernel: selected, error: errorMessage(error) };
        throw error;
      } finally {
        entry.changing = false;
      }
    }
    return entry?.status ?? { state: 'stopped', kernel: null };
  }

  async intelligence(request: NotebookIntelligenceRequest): Promise<NotebookIntelligenceResponse> {
    const path = await this.path(request.source);
    const entry = this.entries.get(path);
    const empty = { matches: [], start: request.cursor, end: request.cursor, documentation: '' };
    if (
      !entry?.bridge ||
      entry.busy ||
      entry.changing ||
      entry.querying ||
      entry.status.state !== 'idle'
    )
      return empty;
    entry.querying = true;
    try {
      const result = await entry.bridge.request(
        { op: 'query', kind: request.kind, code: request.code, cursor: request.cursor },
        5000,
      );
      return result.result ?? empty;
    } catch {
      return empty;
    } finally {
      entry.querying = false;
    }
  }

  async executionStatus(source: CompilationFileTarget) {
    const path = await this.path(source);
    return { execution: this.entries.get(path)?.execution.snapshot() ?? null };
  }

  async widgetState(request: NotebookWidgetsRequest): Promise<NotebookWidgetsResponse> {
    const entry = this.entries.get(await this.path(request.source));
    if (!entry?.bridge || entry.bridge.closed || entry.changing || entry.status.state === 'dead')
      return { generation: null, revision: 0, events: [] };
    return entry.widgets?.snapshot(request) ?? { generation: null, revision: 0, events: [] };
  }

  async widgetComm(request: NotebookWidgetComm): Promise<void> {
    const entry = this.entries.get(await this.path(request.source));
    if (
      !entry?.bridge ||
      entry.bridge.closed ||
      entry.changing ||
      entry.status.state === 'dead' ||
      entry.widgets?.generation !== request.generation
    )
      throw ApiError.conflict(
        'notebook_widget_expired',
        'This widget belongs to a kernel that is no longer active',
      );
    if (
      request.message.msg_type !== 'comm_open' &&
      !entry.widgets.has(request.message.content.comm_id)
    )
      throw ApiError.conflict('notebook_widget_missing', 'This widget is no longer available');
    if (
      request.message.msg_type === 'comm_open' &&
      request.message.content.target_name !== 'jupyter.widget'
    )
      throw ApiError.badRequest('invalid_widget_target', 'Only Jupyter widget comms are supported');
    const bridge = entry.bridge;
    await bridge.request({ op: 'widget', message: request.message }, 5000);
  }

  async executeCells(request: NotebookExecute) {
    const path = await this.path(request.source);
    const entry = this.entry(
      path,
      findCodeExecutable(['jupyter-nbconvert']) ?? 'jupyter-nbconvert',
    );
    if (this.disposed || entry.changing || entry.busy)
      throw ApiError.conflict(
        'notebook_busy',
        'This notebook is already running or changing kernel',
      );
    if (entry.status.state === 'dead')
      throw ApiError.conflict('notebook_kernel_dead', 'Restart the kernel before running again');
    if (entry.environment && (!entry.environment.ipykernel || !entry.environment.nbconvert))
      throw ApiError.badRequest(
        'notebook_packages_missing',
        'Install the missing notebook packages first',
      );
    const execution = entry.execution.begin(request.cells);
    entry.busy = true;
    entry.cancelled = false;
    entry.status = { state: entry.bridge ? 'busy' : 'starting', kernel: entry.selected ?? null };
    entry.finished = (async () => {
      try {
        const bridge = await this.connect(entry);
        if (entry.cancelled || this.disposed) throw new Error('Notebook execution interrupted');
        await bridge.request({
          op: 'cells',
          run_id: execution.id,
          cells: request.cells,
          cwd: dirname(path),
          kernel: entry.selected ?? request.kernel ?? 'python3',
        });
        entry.execution.finish(entry.cancelled ? 'cancelled' : 'succeeded');
      } catch (error) {
        entry.execution.finish(entry.cancelled ? 'cancelled' : 'failed', errorMessage(error));
      } finally {
        entry.busy = false;
        if (entry.status.state !== 'dead')
          entry.status = { ...entry.status, state: entry.bridge ? 'idle' : 'stopped' };
        entry.finished = null;
      }
    })();
    return { execution: entry.execution.snapshot() };
  }

  async replyToInput(request: NotebookInputReply) {
    const path = await this.path(request.source);
    const entry = this.entries.get(path);
    if (!entry?.bridge || !entry.execution.acceptsInput(request))
      throw ApiError.conflict('notebook_input_expired', 'This input request is no longer active');
    await entry.bridge.request(
      { op: 'input', run_id: request.run_id, input_id: request.input_id, value: request.value },
      10_000,
    );
  }

  async execute(
    source: string,
    output: string,
    command: { file: string; args: string[] },
  ): Promise<void> {
    if (this.disposed) throw new Error('Notebook kernels are closed');
    // Notebook commands configure nbconvert's execution options. Arbitrary
    // scripts cannot participate in Jupyter's persistent-kernel lifecycle.
    const name = programName(command.file);
    const args = name.startsWith('jupyter-nbconvert')
      ? command.args
      : name === 'jupyter' && command.args[0] === 'nbconvert'
        ? command.args.slice(1)
        : name.startsWith('python') && command.args[0] === '-m' && command.args[1] === 'nbconvert'
          ? command.args.slice(2)
          : null;
    if (!args)
      throw ApiError.badRequest(
        'invalid_notebook_command',
        'Use jupyter-nbconvert, jupyter nbconvert or python -m nbconvert for notebook execution.',
      );
    const file =
      !isAbsolute(command.file) && hasSeparator(command.file)
        ? resolve(dirname(source), command.file)
        : command.file;
    const canonical = await realpath(source);
    if (this.disposed) throw new Error('Notebook kernels are closed');
    const entry = this.entry(canonical, file);
    if (entry.busy || entry.changing)
      throw ApiError.conflict('notebook_busy', 'This notebook is already running');
    if (entry.status.state === 'dead')
      throw ApiError.conflict(
        'notebook_kernel_dead',
        'The notebook kernel exited. Restart it before running again.',
      );
    if (!entry.environment && entry.bridge && entry.executable !== file)
      throw ApiError.conflict(
        'notebook_environment_changed',
        'Shut down this kernel before changing the notebook executable',
      );
    if (entry.environment && (!entry.environment.ipykernel || !entry.environment.nbconvert))
      throw ApiError.conflict(
        'notebook_packages_missing',
        'Install the missing packages for the selected Python environment before running',
      );
    if (!entry.environment) entry.executable = file;
    entry.busy = true;
    entry.cancelled = false;
    let finish!: () => void;
    entry.finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    entry.status = {
      state: entry.bridge ? 'busy' : 'starting',
      kernel: entry.selected ?? entry.status.kernel,
    };
    let bridge: KernelBridge | null = null;
    try {
      bridge = await this.connect(entry);
      if (entry.cancelled || this.disposed) throw new Error('Notebook execution interrupted');
      entry.status = { ...entry.status, state: 'busy' };
      await bridge.request({
        op: 'run',
        source,
        cwd: dirname(canonical),
        output,
        args,
        kernel: entry.selected,
      });
    } catch (error) {
      entry.status = { ...entry.status, error: errorMessage(error) };
      throw error;
    } finally {
      entry.busy = false;
      if (entry.bridge === bridge && bridge && !bridge.closed && entry.status.state !== 'dead')
        entry.status = { ...entry.status, state: 'idle' };
      finish();
      entry.finished = null;
    }
  }

  /**
   * Closes every bridge. POSIX closes the catalogue's first, then the
   * kernels'. Windows closes them all at once: each close may take its
   * bridge's 3 s shutdown grace and then its stop's 5 s (KernelBridge), and
   * one after another they would hold the daemon's shutdown up past the
   * supervisor's grace for it.
   */
  async dispose(platform: NodeJS.Platform = process.platform): Promise<void> {
    this.disposed = true;
    if (platform === 'win32') {
      await Promise.all([
        this.catalogueBridge?.close(),
        this.cataloguePending,
        ...[...this.entries.values()].map((entry) => this.stop(entry)),
      ]);
      this.entries.clear();
      return;
    }
    await this.catalogueBridge?.close();
    await this.cataloguePending;
    await Promise.all([...this.entries.values()].map((entry) => this.stop(entry)));
    this.entries.clear();
  }

  private async stop(entry: KernelEntry): Promise<void> {
    entry.cancelled = true;
    if (entry.bridge) await entry.bridge.close();
    await entry.finished;
    // Discovery may have completed after shutdown was requested.
    if (entry.bridge) await entry.bridge.close();
  }

  private entry(source: string, executable: string): KernelEntry {
    let entry = this.entries.get(source);
    if (!entry) {
      if (this.entries.size >= 256) {
        const retired = [...this.entries].find(
          ([, item]) => !item.bridge && !item.busy && !item.changing,
        );
        if (retired) this.entries.delete(retired[0]);
      }
      if ([...this.entries.values()].filter((entry) => entry.bridge !== null).length >= 32)
        throw ApiError.conflict(
          'notebook_kernel_limit',
          'Shut down a notebook kernel before opening another (32 maximum)',
        );
      entry = {
        source,
        executable,
        bridge: null,
        selected: null,
        status: { state: 'stopped', kernel: null },
        busy: false,
        changing: false,
        cancelled: false,
        finished: null,
        execution: new NotebookExecutionController(),
        querying: false,
        widgets: null,
      };
      this.entries.set(source, entry);
    }
    return entry;
  }

  private async connect(entry: KernelEntry): Promise<KernelBridge> {
    if (this.disposed) throw new Error('Notebook kernels are closed');
    if (entry.bridge) return entry.bridge;
    if (
      [...this.entries.values()].filter(
        (other) => other !== entry && (other.bridge || other.busy || other.changing),
      ).length >= 32
    )
      throw ApiError.conflict(
        'notebook_kernel_limit',
        'Shut down a notebook kernel before opening another (32 maximum)',
      );
    entry.widgets = new NotebookWidgets();
    const bridge = new KernelBridge(
      entry.environment?.python ?? (await pythonFor(entry.executable)),
      (message) => {
        if (entry.bridge !== bridge) return;
        entry.execution.receive(message);
        if (message.event === 'widget' && message.widget) entry.widgets?.receive(message.widget);
        if (message.event === 'widget-error')
          entry.widgets?.fail(message.error ?? 'Widget channel failed');
        if (message.event === 'dead')
          entry.status = { state: 'dead', kernel: entry.status.kernel, error: message.error };
        if (message.event === 'ready')
          entry.status = { state: entry.busy ? 'busy' : 'idle', kernel: message.kernel ?? null };
      },
      (error) => {
        if (entry.bridge === bridge)
          entry.status = { state: 'dead', kernel: entry.status.kernel, error: errorMessage(error) };
      },
      !!entry.environment,
    );
    entry.bridge = bridge;
    await bridge.ready;
    if (this.disposed) {
      await bridge.close();
      throw new Error('Notebook kernels are closed');
    }
    return bridge;
  }

  private async path(source: CompilationFileTarget): Promise<string> {
    const root = resolveFsRoot(this.deps, source.session, source.root);
    const path = containedPath(root, source.path);
    if (!source.path.toLowerCase().endsWith('.ipynb') || !(await stat(path)).isFile())
      throw ApiError.badRequest('invalid_notebook', 'Choose a notebook file');
    return realpath(path);
  }
}

/**
 * A command's program name for classification. Windows compares names as its
 * file system does: without `.exe` and ignoring case.
 */
export function programName(file: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return basename(file);
  const name = win32.basename(file).toLowerCase();
  return name.endsWith('.exe') ? name.slice(0, -'.exe'.length) : name;
}

/** Whether a relative command names a path (`./venv/bin/jupyter`, `.\venv\Scripts\jupyter`). */
function hasSeparator(file: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? /[\\/]/.test(file) : file.includes('/');
}

/** Prefer the environment that installed nbconvert, instead of another PATH Python. */
export async function pythonFor(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const resolved = isAbsolute(executable) ? executable : findCodeExecutable([executable]);
  if (!resolved) throw new Error(`${executable} is not installed on this host`);
  if (programName(resolved, platform).startsWith('python')) return resolved;
  // Windows console scripts are launcher executables without a shebang line.
  const launched = platform === 'win32' ? launcherPython(resolved) : null;
  if (launched) return launched;
  const handle = await open(resolved, 'r');
  let header: string;
  try {
    const bytes = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    header = bytes.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '';
  } finally {
    await handle.close();
  }
  const shebang = /^#!\s*(\S+)/.exec(header)?.[1];
  if (shebang && isAbsolute(shebang) && basename(shebang).startsWith('python')) return shebang;
  const python = findCodeExecutable(
    platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'],
  );
  if (!python) throw new Error('Python with Jupyter packages is not installed on this host');
  return python;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(-512);
}
