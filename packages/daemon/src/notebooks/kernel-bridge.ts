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
  type ChildProcessTree,
} from '@puddle/shared/node/platform';
import { NOTEBOOK_BRIDGE } from './bridge.js';
import { pythonEnvironment } from './python-env.js';

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
  /** When the bridge was started, and when it named its kernel (this process's clock). */
  private readonly startedAtMs: number;
  private kernelNamedAtMs = 0;
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

  constructor(
    python: string,
    onMessage?: (message: z.infer<typeof messageSchema>) => void,
    onExit?: (error: string) => void,
    exactPython = false,
  ) {
    const env = pythonEnvironment(python);
    this.startedAtMs = Date.now();
    this.child = spawn(
      python,
      ['-u', '-c', NOTEBOOK_BRIDGE, ...(exactPython ? ['--puddle-python'] : [])],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(env ? { env } : {}) },
    );
    this.tree = childProcessTree(this.child, this.startedAtMs);
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
              this.kernelNamedAtMs = Date.now();
            }
            if (message.event === 'stopped' || message.event === 'dead') this.pid = null;
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

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.killKernel();
        if (process.platform === 'win32' && this.child.pid !== undefined) {
          // The bridge's tree, which includes any kernel it still owns.
          void this.tree.kill();
        } else this.child.kill('SIGKILL');
      }, 3000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.stdin.end(`${JSON.stringify({ op: 'shutdown' })}\n`);
    });
    return this.closePromise;
  }

  private killKernel(): void {
    if (!this.pid) return;
    if (process.platform === 'win32') {
      // No process groups: stop the kernel and what it started as the
      // process table shows its tree (never a GUI programme, nor what one
      // started, but console processes it started detached as well). The
      // kernel is the bridge's child, created before the bridge named it:
      // a later holder of its pid is another process.
      void killProcessTree(this.pid, {
        root: {
          startedAtMs: this.startedAtMs,
          createdBeforeMs: this.kernelNamedAtMs,
          ...(this.child.pid !== undefined ? { parentPid: this.child.pid } : {}),
        },
      });
      this.pid = null;
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
