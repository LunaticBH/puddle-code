import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import {
  notebookKernelSpecSchema,
  notebookExecutionCellSchema,
  notebookInputSchema,
  notebookIntelligenceResponseSchema,
  notebookWidgetMessageSchema,
} from '@puddle/shared';
import {
  childProcessTree,
  killProcessTree,
  listWindowsProcesses,
  windowsProcessTree,
  type ChildProcessTree,
  type ProcessTreeRoot,
  type WindowsProcess,
} from '@puddle/shared/node/platform';
import { NOTEBOOK_BRIDGE } from './bridge.js';
import { pythonEnvironment } from './python-env.js';

/**
 * The creation time of the kernel a bridge named on Windows, from a table
 * read while the bridge most likely still runs, or null when the table
 * cannot vouch for it. The kernel is in the bridge's tree, not necessarily
 * its child: a venv's python.exe (CPython 3.7.2 and later, uv, virtualenv)
 * and py.exe run the real interpreter as their own child, so the process
 * the daemon started is the real bridge's parent, and the pid the bridge
 * names (for a venv, the kernel's own redirector) is the real bridge's
 * child. The kernel was created before the bridge named it (`namedAtMs`): a
 * holder of its pid created later is another process, as is one outside the
 * bridge's tree.
 */
export function windowsKernelIdentity(
  table: readonly WindowsProcess[],
  bridge: ProcessTreeRoot,
  kernelPid: number,
  namedAtMs: number,
): number | null {
  const [kernel] = windowsProcessTree(table, {
    pid: kernelPid,
    ...(bridge.startedAtMs !== undefined ? { startedAtMs: bridge.startedAtMs } : {}),
    createdBeforeMs: namedAtMs,
  });
  if (kernel?.pid !== kernelPid || kernel.createdAtMs === null || kernelPid === bridge.pid) {
    return null;
  }
  const member = windowsProcessTree(table, bridge).some(
    (entry) => entry.pid === kernel.pid && entry.createdAtMs === kernel.createdAtMs,
  );
  return member ? kernel.createdAtMs : null;
}

/** How long close waits for a Windows tree stop (a few process-table reads). */
const STOP_WAIT_MS = 5_000;

export const messageSchema = z.object({
  event: z
    .enum([
      'catalogue',
      'spawned',
      'ready',
      'stopped',
      'dead',
      'cell',
      'input',
      'input-cleared',
      'widget',
      'widget-error',
    ])
    .optional(),
  result: notebookIntelligenceResponseSchema.optional(),
  widget: notebookWidgetMessageSchema.optional(),
  run_id: z.string().uuid().optional(),
  cell: notebookExecutionCellSchema.optional(),
  input: notebookInputSchema.optional(),
  id: z.number().int().optional(),
  ok: z.boolean().optional(),
  error: z.string().optional(),
  kernel: z.string().optional(),
  pid: z.number().int().positive().optional(),
  kernels: z.array(notebookKernelSpecSchema).optional(),
});

export class KernelBridge {
  readonly ready: Promise<z.infer<typeof notebookKernelSpecSchema>[]>;
  readonly child: ChildProcessWithoutNullStreams;
  closed = false;
  private pid: number | null = null;
  /** Windows: the kernel's creation time (windowsKernelIdentity), once the table is read. */
  private kernelIdentity: Promise<number | null> | null = null;
  /** What identifies the bridge's process tree on Windows. */
  private readonly tree: ChildProcessTree;
  private sequence = 0;
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private stderr = '';
  private readonly pending = new Map<
    number,
    {
      resolve(value: z.infer<typeof messageSchema>): void;
      reject(error: Error): void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private closePromise: Promise<void> | null = null;
  /**
   * Windows: tree stops still running, each of which reads the process table
   * before it ends anything; close waits for them (stopsSettled).
   */
  private readonly stops = new Set<Promise<void>>();

  constructor(
    python: string,
    onMessage?: (message: z.infer<typeof messageSchema>) => void,
    onExit?: (error: string) => void,
    exactPython = false,
  ) {
    const env = pythonEnvironment(python);
    const startedAtMs = Date.now();
    this.child = spawn(
      python,
      ['-u', '-c', NOTEBOOK_BRIDGE, ...(exactPython ? ['--puddle-python'] : [])],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(env ? { env } : {}) },
    );
    this.tree = childProcessTree(this.child, startedAtMs);
    const child = this.child;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Jupyter discovery timed out'));
        void this.close();
      }, 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        this.buffer += this.decoder.write(chunk);
        if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) {
          reject(new Error('Invalid kernel bridge output'));
          void this.close();
          return;
        }
        for (;;) {
          const end = this.buffer.indexOf('\n');
          if (end < 0) break;
          const line = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          try {
            const message = messageSchema.parse(JSON.parse(line));
            if (message.event === 'catalogue') {
              clearTimeout(timer);
              resolve(message.kernels ?? []);
            }
            if (message.event === 'spawned' && message.pid) {
              this.pid = message.pid;
              this.kernelIdentity =
                process.platform === 'win32' ? this.identifyKernel(message.pid, Date.now()) : null;
            }
            if (message.event === 'stopped' || message.event === 'dead') {
              this.pid = null;
              this.kernelIdentity = null;
            }
            onMessage?.(message);
            if (message.id !== undefined) {
              const pending = this.pending.get(message.id);
              if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(message.id);
                if (message.error) pending.reject(new Error(message.error));
                else pending.resolve(message);
              }
            }
          } catch {
            reject(new Error('Invalid kernel bridge response'));
            void this.close();
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString('utf8')).slice(-32768);
      });
      const fail = (error: Error) => {
        clearTimeout(timer);
        this.closed = true;
        reject(error);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        this.killKernel();
        onExit?.(error.message);
      };
      child.once('error', fail);
      child.once('exit', () => fail(new Error(this.stderr.trim() || 'Notebook kernel stopped')));
      child.stdin.on('error', () => {
        /* The exit handler rejects every pending operation. */
      });
    });
  }

  request(
    message: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<z.infer<typeof messageSchema>> {
    if (this.closed || this.closePromise)
      return Promise.reject(new Error('Notebook kernel stopped'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error('Kernel operation timed out'));
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    });
  }

  /**
   * Resolves once the bridge has exited, and on Windows once the stops of
   * its tree and its kernel's have been carried out (or after
   * STOP_WAIT_MS): a daemon that exited sooner would leave them running.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return this.stopsSettled();
    this.closePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.killKernel();
        if (process.platform === 'win32' && this.child.pid !== undefined) {
          // The bridge's tree, which includes any kernel it still owns.
          this.track(this.tree.kill());
        } else this.child.kill('SIGKILL');
      }, 3000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        // (The exit has just begun the kernel's stop, if it still ran.)
        if (this.stops.size === 0) resolve();
        else void this.stopsSettled().then(resolve);
      });
      this.child.stdin.end(`${JSON.stringify({ op: 'shutdown' })}\n`);
    });
    return this.closePromise;
  }

  /** Windows: holds `stop` until it has finished, for close. */
  private track(stop: Promise<unknown>): void {
    const tracked: Promise<void> = stop
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => this.stops.delete(tracked));
    this.stops.add(tracked);
  }

  /** Once every tracked stop has finished, or after STOP_WAIT_MS; never rejects. */
  private stopsSettled(): Promise<void> {
    if (this.stops.size === 0) return Promise.resolve();
    const pending = Promise.all(this.stops);
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, STOP_WAIT_MS);
      void pending.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Windows: reads the table as soon as the bridge names its kernel, while
   * the bridge, whose tree vouches for the kernel, still runs. Never rejects.
   */
  private async identifyKernel(pid: number, namedAtMs: number): Promise<number | null> {
    const bridge = this.child.pid;
    if (bridge === undefined) return null;
    // What is known of the bridge before the table is read: an exit noted
    // after the read would hide a bridge the table shows running.
    const root = { pid: bridge, ...this.tree.root() };
    try {
      return windowsKernelIdentity(
        await listWindowsProcesses({ fresh: true }),
        root,
        pid,
        namedAtMs,
      );
    } catch {
      return null;
    }
  }

  private killKernel(): void {
    if (!this.pid) return;
    if (process.platform === 'win32') {
      // No process groups: stop the kernel and what it started as the
      // process table shows its tree (never a GUI programme, nor what one
      // started, but console processes it started detached as well), once
      // it is identified by its creation time: a later holder of its pid is
      // another process. One the table could not vouch for is left running.
      const pid = this.pid;
      const identity = this.kernelIdentity;
      this.pid = null;
      this.kernelIdentity = null;
      if (identity) {
        this.track(
          identity.then((createdAtMs) =>
            createdAtMs === null ? undefined : killProcessTree(pid, { root: { createdAtMs } }),
          ),
        );
      }
      return;
    }
    try {
      process.kill(-this.pid, 'SIGKILL');
    } catch {
      /* Already stopped by Jupyter. */
    }
    this.pid = null;
  }
}
