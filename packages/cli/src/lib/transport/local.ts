import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { clientHome } from '../paths.js';
import { CliError } from '../types.js';
import type { ExecOptions, ExecResult, Transport } from './transport.js';

export interface LocalTransportOptions {
  /** Injected for tests; win32 has no shell for host operations. */
  platform?: NodeJS.Platform;
}

/** Local mode: commands run on this machine, files read from this disk. */
export class LocalTransport implements Transport {
  readonly kind = 'local' as const;
  readonly label = 'this machine';
  readonly platform: NodeJS.Platform;

  constructor(opts: LocalTransportOptions = {}) {
    this.platform = opts.platform ?? process.platform;
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.platform === 'win32') {
      // Host operations on Windows have Node implementations (docs/windows.md,
      // decision 4); a call site that still reaches for sh must fail loudly,
      // never run under whichever sh (Git Bash's, with MSYS paths) is on PATH.
      return Promise.reject(
        new CliError(
          'unsupported_platform',
          'this host operation has no Windows implementation yet',
          'report it with the command you ran',
        ),
      );
    }
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
        timer.unref();
      }
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        opts.onStdout?.(text);
      });
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + String(err) });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      child.stdin.on('error', () => {}); // A command may exit before reading all input.
      if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
      else child.stdin.end();
    });
  }

  readFile(path: string): Promise<string | null> {
    try {
      return Promise.resolve(readFileSync(expandHome(path), 'utf8'));
    } catch {
      return Promise.resolve(null);
    }
  }

  copyTo(localPath: string, destPath: string): Promise<void> {
    const dest = expandHome(destPath);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(localPath, dest);
    return Promise.resolve();
  }

  dispose(): void {}
}

/**
 * True for this machine on Windows, where every host operation takes its
 * Node implementation instead of a shell script (docs/windows.md, decision 4).
 */
export function isLocalWindows(transport: Transport): transport is LocalTransport {
  return transport instanceof LocalTransport && transport.platform === 'win32';
}

/**
 * Host-path constants are shell expressions (`"${PUDDLE_HOME:-$HOME/.puddle}"`)
 * for exec'd commands; direct fs access resolves them the same way the
 * daemon's paths.ts does.
 */
function expandHome(path: string): string {
  return path.startsWith('"${PUDDLE_HOME:-$HOME/.puddle}"')
    ? clientHome() + path.slice('"${PUDDLE_HOME:-$HOME/.puddle}"'.length)
    : path;
}
