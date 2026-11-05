import {
  spawn,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
} from 'node:child_process';
import { win32 } from 'node:path';
import {
  childProcessTree,
  resolveSpawn,
  restoreCurrentDirectorySearch,
  type ChildProcessTree,
} from '@puddle/shared/node/platform';
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

/** Each running command, with what identifies its process tree on Windows. */
const liveCommands = new Map<ReturnType<typeof spawn>, ChildProcessTree>();

/**
 * Terminate compiler process groups when their owning daemon shuts down.
 * POSIX signals each group at once and resolves. On Windows it resolves once
 * each command's tree has been stopped: that stop reads the process table
 * before it ends anything (terminateGroup), and a daemon that exited first
 * would leave the command's descendants running, as libuv's kill-on-close
 * job ends the command alone. Never rejects.
 */
export function disposeCompilationCommands(): Promise<void> {
  const commands = [...liveCommands];
  const stops = commands.map(([child, tree]) => terminateGroup(child, tree, 'SIGTERM'));
  setTimeout(() => {
    for (const [child, tree] of commands) {
      if (liveCommands.has(child)) void terminateGroup(child, tree, 'SIGKILL');
    }
  }, 1_000).unref();
  return Promise.all(stops).then(() => undefined);
}

/**
 * How `command` is started without a shell. POSIX makes it lead a new
 * process group, which cancellation signals as a whole. Windows has no
 * process groups to signal: the command stays attached so that, with
 * `windowsHide`, it and every console grandchild share one hidden console
 * (a detached command's grandchildren would each open a visible window), and
 * cancellation stops its tree (terminateGroup). npm-style `.cmd` shims and other
 * batch files are resolved first, since Node will not start them directly,
 * and a relative path such as `.\tools\build.exe` names a file in the
 * command's working directory, as on POSIX. Throws `UnsafeCmdArgumentError`
 * for a batch file whose arguments cmd.exe cannot carry, and ENOENT for a
 * bare name not found on PATH: spawned bare, libuv would look for it in the
 * command's working directory first, inside the repository.
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
  // Without the daemon's own NoDefaultCurrentDirectoryInExePath setting, the
  // command's children (a build script calling a sibling tool) find
  // programmes in the working directory as they would in a console.
  const env = { ...(command.env ?? process.env) };
  restoreCurrentDirectorySearch(env, platform);
  const resolved = resolveSpawn(command.file, command.args, {
    platform,
    env,
    cwd: command.cwd,
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
      env: resolved.env ? withEnvironment(resolved.env, env, platform) : env,
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
    const startedAtMs = Date.now();
    const child = spawn(plan.file, plan.args, plan.options);
    const tree = childProcessTree(child, startedAtMs);
    liveCommands.set(child, tree);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let exited = false;
    let forced = false;

    const terminate = (): void => {
      void terminateGroup(child, tree, 'SIGTERM');
      setTimeout(() => {
        if (exited || child.pid === undefined) return;
        forced = true;
        void terminateGroup(child, tree, 'SIGKILL');
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

/**
 * POSIX signals the command's process group. Windows has no groups to
 * signal: it always forces the tree the process table shows, by
 * creation-time-consistent links, and the command itself by its own handle
 * (killProcessTree), but never a GUI programme the command started, nor
 * what that started (docs/windows.md, decision 8). Unlike the group, the
 * tree includes console processes the command started detached or in a
 * console of their own (a server started with `start`, say): they end with
 * it. Resolves once the stop has been carried out (at once on POSIX);
 * never rejects.
 */
function terminateGroup(
  child: ReturnType<typeof spawn>,
  tree: ChildProcessTree,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (child.pid === undefined) return Promise.resolve();
  if (platform === 'win32') return tree.kill({ platform }).catch(() => undefined);
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
  return Promise.resolve();
}
