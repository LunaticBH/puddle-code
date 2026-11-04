import {
  spawn,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
} from 'node:child_process';
import { win32 } from 'node:path';
import { killProcessTree, resolveSpawn } from '@puddle/shared/node/platform';
import { withEnvironment } from './environment.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface CompilationCommand {
  file: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CompilationCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CompilationCommandRunner = (
  command: CompilationCommand,
) => Promise<CompilationCommandResult>;

export class CompilationCommandError extends Error {
  constructor(
    message: string,
    public readonly command: CompilationCommand,
    public readonly result?: CompilationCommandResult,
  ) {
    super(message);
    this.name = 'CompilationCommandError';
  }
}

type CompilationSpawnOptions = SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>;

const liveCommands = new Set<ReturnType<typeof spawn>>();

/** Terminate compiler process groups when their owning daemon shuts down. */
export function disposeCompilationCommands(): void {
  const commands = [...liveCommands];
  for (const child of commands) terminateGroup(child, 'SIGTERM');
  setTimeout(() => {
    for (const child of commands) {
      if (liveCommands.has(child)) terminateGroup(child, 'SIGKILL');
    }
  }, 1_000).unref();
}

/**
 * How `command` is started without a shell. POSIX makes it lead a new
 * process group, which cancellation signals as a whole. Windows has no
 * process groups to signal: the command stays attached so that, with
 * `windowsHide`, it and every console grandchild share one hidden console
 * (a detached command's grandchildren would each open a visible window), and
 * cancellation stops the tree with taskkill. npm-style `.cmd` shims and other
 * batch files are resolved first, since Node will not start them directly.
 * Throws `UnsafeCmdArgumentError` for a batch file whose arguments cmd.exe
 * cannot carry, and ENOENT for a name not found on PATH: spawned bare, libuv
 * would look for it in the command's working directory first, inside the
 * repository.
 */
export function compilationSpawn(
  command: CompilationCommand,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; options: CompilationSpawnOptions } {
  const stdio: CompilationSpawnOptions['stdio'] = ['ignore', 'pipe', 'pipe'];
  if (platform !== 'win32') {
    return {
      file: command.file,
      args: command.args,
      options: { cwd: command.cwd, env: command.env, detached: true, stdio },
    };
  }
  const resolved = resolveSpawn(command.file, command.args, {
    platform,
    env: command.env ?? process.env,
  });
  if (!win32.isAbsolute(resolved.file)) {
    throw Object.assign(new Error(`spawn ${command.file} ENOENT`), {
      code: 'ENOENT',
      syscall: 'spawn',
      path: command.file,
    });
  }
  return {
    file: resolved.file,
    args: resolved.args,
    options: {
      cwd: command.cwd,
      env: resolved.env ? withEnvironment(resolved.env, command.env, platform) : command.env,
      stdio,
      windowsHide: true,
      ...(resolved.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    },
  };
}

/**
 * Run one compiler command without a shell, with bounded time/output and an
 * isolated process group so cancellation also reaches processes started by providers.
 */
export const runCompilationCommand: CompilationCommandRunner = (command) =>
  new Promise((resolve, reject) => {
    const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    let plan: ReturnType<typeof compilationSpawn>;
    try {
      plan = compilationSpawn(command);
    } catch (error) {
      reject(
        new CompilationCommandError(
          `Could not start Compilation command: ${(error as Error).message}`,
          command,
          { exitCode: 1, stdout: '', stderr: '' },
        ),
      );
      return;
    }
    const child = spawn(plan.file, plan.args, plan.options);
    liveCommands.add(child);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let exited = false;
    let forced = false;

    const terminate = (): void => {
      terminateGroup(child, 'SIGTERM');
      setTimeout(() => {
        if (exited || child.pid === undefined) return;
        forced = true;
        terminateGroup(child, 'SIGKILL');
      }, 1_000).unref();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      terminate();
      rejectOnce(`Compilation command exceeded ${timeoutMs} ms`);
    }, timeoutMs);
    timer.unref();

    const rejectOnce = (message: string, result?: CompilationCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new CompilationCommandError(
          message,
          command,
          result ?? {
            exitCode: 1,
            stdout: stdout.toString('utf8'),
            stderr: stderr.toString('utf8'),
          },
        ),
      );
    };

    const collect = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (settled) return;
      if (stdout.byteLength + stderr.byteLength + chunk.byteLength > maxOutputBytes) {
        terminate();
        rejectOnce(`Compilation command output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      if (which === 'stdout') stdout = Buffer.concat([stdout, chunk]);
      else stderr = Buffer.concat([stderr, chunk]);
    };

    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.once('error', (error) =>
      rejectOnce(`Could not start Compilation command: ${error.message}`),
    );
    child.once('close', (code, signal) => {
      liveCommands.delete(child);
      exited = true;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        exitCode: code ?? (forced || signal === 'SIGKILL' ? 137 : 1),
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      };
      if (code === 0) resolve(result);
      else {
        reject(
          new CompilationCommandError(
            `Compilation command exited with ${result.exitCode}${signal ? ` (${signal})` : ''}`,
            command,
            result,
          ),
        );
      }
    });
  });

function terminateGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  if (child.pid === undefined) return;
  if (platform === 'win32') {
    // Always forced: without /F, taskkill only asks GUI windows to close.
    void killProcessTree(child.pid, { platform });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
