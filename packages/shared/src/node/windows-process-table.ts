import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { system32Path } from './environment.js';

/**
 * The Windows replacement for `ps` (docs/windows.md, decision 8): one
 * persistent, hidden Windows PowerShell worker answering `Win32_Process`
 * queries over stdin/stdout, so callers pay PowerShell's start-up once rather
 * than on every scan.
 *
 * Measured on Windows 11 (Node 24, ~390 processes, ~190 KB of JSON): the
 * first call, which starts the worker, takes 400-470 ms; warm calls take
 * 75-110 ms. Concurrent calls share one query, results are reused for
 * 250 ms, and an idle worker exits after 30 s.
 */

export interface WindowsProcess {
  readonly pid: number;
  readonly ppid: number;
  /** As Windows reports it, e.g. `node.exe`. */
  readonly name: string;
  /** `name` without `.exe`, in lower case: the form process recognition compares. */
  readonly command: string;
  /** Null when Windows withholds it: another user's or a protected process. */
  readonly commandLine: string | null;
  /** Creation time in Unix milliseconds; null for the idle and system pseudo-processes. */
  readonly createdAtMs: number | null;
}

export interface WindowsProcessTableOptions {
  /** The worker to run; Windows PowerShell 5.1 by default. Tests substitute a fake. */
  worker?: { file: string; args: readonly string[] };
  /** How long a result is reused; 250 ms by default. */
  cacheMs?: number;
  /** Per-query bound, after which the worker is replaced; 8 s by default. */
  timeoutMs?: number;
  /** Idle time before the worker exits; 30 s by default. */
  idleMs?: number;
  /** Bound on one answer; 16 MiB by default. */
  maxOutputBytes?: number;
}

const POWERSHELL_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  '-',
];

const SETUP =
  "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; " +
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n';

/** One line: compact JSON (or `{"error": …}`), then a newline, the marker and a newline. */
function query(marker: string): string {
  return (
    'try { $r = @(Get-CimInstance -ClassName Win32_Process -Property ' +
    'ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ForEach-Object { ' +
    '[pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; n = $_.Name; ' +
    'c = $_.CommandLine; t = $(if ($_.CreationDate) { ' +
    '([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }) } }); ' +
    '[Console]::Out.Write((ConvertTo-Json -InputObject $r -Compress -Depth 2)) } ' +
    'catch { [Console]::Out.Write(\'{"error":\' + ' +
    "(ConvertTo-Json -InputObject ([string]$_.Exception.Message) -Compress) + '}') }; " +
    `[Console]::Out.Write([string][char]10 + '${marker}' + [char]10); [Console]::Out.Flush()\n`
  );
}

export class WindowsProcessTable {
  private readonly options: Required<WindowsProcessTableOptions>;
  private worker: TableWorker | null = null;
  private inflight: Promise<readonly WindowsProcess[]> | null = null;
  private cached: { at: number; processes: readonly WindowsProcess[] } | null = null;
  private idle: NodeJS.Timeout | null = null;

  constructor(options: WindowsProcessTableOptions = {}) {
    this.options = {
      worker: options.worker ?? {
        file: system32Path(win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
        args: POWERSHELL_ARGS,
      },
      cacheMs: options.cacheMs ?? 250,
      timeoutMs: options.timeoutMs ?? 8_000,
      idleMs: options.idleMs ?? 30_000,
      maxOutputBytes: options.maxOutputBytes ?? 16 * 1024 * 1024,
    };
  }

  /** Every process, as one snapshot. Rejects when the query fails or times out. */
  async list(): Promise<WindowsProcess[]> {
    const cached = this.cached;
    if (cached && performance.now() - cached.at < this.options.cacheMs) {
      return [...cached.processes];
    }
    this.inflight ??= this.query().finally(() => {
      this.inflight = null;
    });
    return [...(await this.inflight)];
  }

  /** Stops the worker now; a later `list` starts a new one. */
  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.worker?.stop();
    this.worker = null;
  }

  private async query(): Promise<readonly WindowsProcess[]> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const worker = this.worker && !this.worker.dead ? this.worker : this.start();
    try {
      const body = await worker.request(this.options.timeoutMs, this.options.maxOutputBytes);
      const processes = parseProcesses(body);
      this.cached = { at: performance.now(), processes };
      return processes;
    } finally {
      this.idle = setTimeout(() => this.close(), this.options.idleMs);
      this.idle.unref();
    }
  }

  private start(): TableWorker {
    const worker = new TableWorker(this.options.worker, () => {
      if (this.worker === worker) this.worker = null;
    });
    this.worker = worker;
    return worker;
  }
}

let shared: WindowsProcessTable | null = null;

/** Every process on this Windows machine, from the shared persistent worker. */
export function listWindowsProcesses(): Promise<WindowsProcess[]> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('The Windows process table is only available on Windows'));
  }
  shared ??= new WindowsProcessTable();
  return shared.list();
}

interface PendingQuery {
  end: string;
  text: string;
  bytes: number;
  maxBytes: number;
  decoder: StringDecoder;
  settle: (error: Error | null, body?: string) => void;
}

/**
 * The worker process. Its handles hold the event loop only while a query is
 * outstanding, so an idle worker never keeps the host process alive; when
 * the host exits, PowerShell reads end-of-file on stdin and exits too.
 */
class TableWorker {
  dead = false;
  private readonly child: ChildProcess;
  private readonly token = randomBytes(8).toString('hex');
  private sequence = 0;
  private stderr = '';
  private pending: PendingQuery | null = null;

  constructor(
    spec: { file: string; args: readonly string[] },
    private readonly onExit: () => void,
  ) {
    this.child = spawn(spec.file, [...spec.args], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin!.on('error', () => this.stop());
    this.child.stdout!.on('error', () => this.stop());
    this.child.stderr!.on('error', () => {});
    this.child.stdout!.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stderr!.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2048);
    });
    this.child.on('error', (err) => this.exited(err.message));
    this.child.on('exit', (code) => this.exited(`exit code ${code}`));
    this.child.stdin!.write(SETUP);
    this.reference(false);
  }

  request(timeoutMs: number, maxBytes: number): Promise<string> {
    if (this.dead) return Promise.reject(new Error('The process table worker has exited'));
    if (this.pending) return Promise.reject(new Error('The process table worker is busy'));
    const marker = `__PUDDLE_PROCESS_TABLE_END_${this.token}_${++this.sequence}__`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending?.settle(new Error(`The process table query timed out after ${timeoutMs} ms`));
        this.stop();
      }, timeoutMs);
      this.pending = {
        end: `\n${marker}\n`,
        text: '',
        bytes: 0,
        maxBytes,
        decoder: new StringDecoder('utf8'),
        settle: (error, body) => {
          clearTimeout(timer);
          this.pending = null;
          this.reference(false);
          if (error) reject(error);
          else resolve(body!);
        },
      };
      this.reference(true);
      this.child.stdin!.write(query(marker));
    });
  }

  stop(): void {
    if (!this.dead) this.child.kill();
    this.exited('stopped');
  }

  private receive(chunk: Buffer): void {
    const pending = this.pending;
    if (!pending) return; // nothing is expected between queries
    pending.bytes += chunk.length;
    if (pending.bytes > pending.maxBytes) {
      pending.settle(new Error(`The process table answer exceeded ${pending.maxBytes} bytes`));
      this.stop();
      return;
    }
    // The marker may straddle chunks: search from just before the new text.
    const from = Math.max(0, pending.text.length - pending.end.length);
    pending.text += pending.decoder.write(chunk);
    const at = pending.text.indexOf(pending.end, from);
    if (at !== -1) pending.settle(null, pending.text.slice(0, at));
  }

  private exited(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.reference(false);
    const detail = this.stderr.trim();
    this.pending?.settle(
      new Error(`The process table worker stopped (${reason})${detail ? `: ${detail}` : ''}`),
    );
    this.onExit();
  }

  private reference(on: boolean): void {
    const handles = [this.child, this.child.stdin, this.child.stdout, this.child.stderr];
    for (const handle of handles as Array<{ ref?: () => void; unref?: () => void } | null>) {
      if (on) handle?.ref?.();
      else handle?.unref?.();
    }
  }
}

function parseProcesses(body: string): readonly WindowsProcess[] {
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) {
    const message = (parsed as { error?: unknown } | null)?.error;
    throw new Error(`The process table query failed: ${String(message ?? 'unexpected answer')}`);
  }
  const processes: WindowsProcess[] = [];
  for (const entry of parsed as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { p, q, n, c, t } = entry as Record<string, unknown>;
    if (!isId(p) || !isId(q) || typeof n !== 'string') continue;
    processes.push(
      Object.freeze({
        pid: p,
        ppid: q,
        name: n,
        command: n.replace(/\.exe$/i, '').toLowerCase(),
        commandLine: typeof c === 'string' ? c : null,
        createdAtMs: typeof t === 'number' && Number.isFinite(t) ? t : null,
      }),
    );
  }
  return Object.freeze(processes);
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
