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
import { mayEndTree, stopOwnConsole, type OwnConsoleDeps } from '../pty/own-console.js';
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

/** How a command is stopped; tests substitute the Windows stop to run it on any OS. */
export interface CompilationStopOptions {
  /** Whose stop to run: POSIX signals, or Windows' (`process.platform` by default). */
  platform?: NodeJS.Platform;
  /** Windows: ends the command and its descendants; terminateWindows by default. */
  stopWindows?: (child: ReturnType<typeof spawn>, tree: ChildProcessTree) => Promise<void>;
}

/** A running command's stop: its group's signal, or its Windows stop (commandStop). */
type CommandStop = (signal: NodeJS.Signals) => Promise<void>;

/** Each running command, and how to stop it. */
const liveCommands = new Map<ReturnType<typeof spawn>, CommandStop>();

/**
 * Windows stops under way, whether or not their command is still running: a
 * command whose stop (a cancellation's) is still ending its descendants may
 * close meanwhile, and leave liveCommands, before the stop is done.
 */
const runningStops = new Set<Promise<void>>();

/**
 * Terminate compiler process groups when their owning daemon shuts down.
 * POSIX signals each group at once and resolves. On Windows it resolves once
 * each command's stop, and every stop still under way, has been carried out:
 * a stop reads the process table before it ends anything (terminateWindows),
 * and a daemon that exited first would leave the command's descendants
 * running, as libuv's kill-on-close job ends the command alone. Never
 * rejects.
 */
export function disposeCompilationCommands(): Promise<void> {
  const commands = [...liveCommands];
  const stops = commands.map(([, stop]) => stop('SIGTERM'));
  setTimeout(() => {
    for (const [child, stop] of commands) {
      if (liveCommands.has(child)) void stop('SIGKILL');
    }
  }, 1_000).unref();
  return Promise.all([...stops, ...runningStops]).then(() => undefined);
}

/**
 * How `command` is started without a shell. POSIX makes it lead a new
 * process group, which cancellation signals as a whole. Windows has no
 * process groups to signal: the command stays attached so that, with
 * `windowsHide` and no inherited stdio, libuv gives it CREATE_NO_WINDOW, a
 * hidden console of its own that every console grandchild shares (a
 * detached command's grandchildren would each open a visible window), and
 * cancellation ends that console (terminateWindows). npm-style `.cmd` shims and other
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
export const runCompilationCommand = (
  command: CompilationCommand,
  options: CompilationStopOptions = {},
): Promise<CompilationCommandResult> =>
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
    const stop = commandStop(child, childProcessTree(child, startedAtMs), options);
    liveCommands.set(child, stop);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let exited = false;
    let forced = false;

    const terminate = (): void => {
      void stop('SIGTERM');
      setTimeout(() => {
        if (exited || child.pid === undefined) return;
        forced = true;
        void stop('SIGKILL');
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
 * `child`'s stop: POSIX signals its group (terminateGroup), Windows runs
 * its stop (terminateWindows). On Windows a stop asked for while
 * another runs joins it rather than running beside it: each reads its own
 * process table, and the later one could end a pid the earlier one had
 * already ended, by then another process's. The SIGKILL that follows a
 * timeout's SIGTERM, and the daemon's dispose during a cancellation, so wait
 * for the stop under way; once it is done, another may run (for what the
 * command started meanwhile), which never falls back on the command's tree
 * once one has gone by its console (terminateWindows). Every Windows stop is
 * in runningStops until it is done.
 */
function commandStop(
  child: ReturnType<typeof spawn>,
  tree: ChildProcessTree,
  options: CompilationStopOptions,
): CommandStop {
  const platform = options.platform ?? process.platform;
  const stopWindows = options.stopWindows ?? terminateWindows;
  let running: Promise<void> | null = null;
  return (signal) => {
    if (platform !== 'win32') return terminateGroup(child, signal);
    if (child.pid === undefined) return Promise.resolve();
    if (running) return running;
    const stop: Promise<void> = stopWindows(child, tree)
      .catch(() => undefined)
      .finally(() => {
        if (running === stop) running = null;
        runningStops.delete(stop);
      });
    running = stop;
    runningStops.add(stop);
    return stop;
  };
}

/**
 * Commands whose own console a Windows stop has ended, or found closed, with
 * the ConPTY helper: no later stop of theirs (the SIGKILL that follows a
 * SIGTERM, or the daemon's dispose) ends their tree, which would end what
 * left that console.
 */
const consoleStopped = new WeakSet<ReturnType<typeof spawn>>();

/**
 * Windows has no process groups to signal. The command's own console stands
 * for its group (pty/own-console.ts): the command ends by its own handle,
 * with every process the ConPTY helper finds attached to that console,
 * those its descendants left there as they exited (`cmd /c start /b`)
 * included, and what left it outlives it, as a POSIX `setsid` does: a
 * detached process, or one in a console of its own (`start`,
 * `Start-Process`), even one that holds the command's output open. Once the
 * helper has found the console closed, as it is once the command has exited
 * and everything on its console has ended or left it, nothing more ends but
 * the command, by its handle, and so for every later stop of the command's.
 * Without the helper, or for a command that never had a console (its image
 * a GUI programme's), it forces the tree the process table shows, by
 * creation-time-consistent links, and the command by its handle
 * (killProcessTree); unlike the group, that tree includes console processes
 * the command started detached or in a console of their own, and misses
 * those whose parent has exited. Neither ever ends a GUI programme the
 * command started, nor what that started (docs/windows.md, decision 8).
 * Resolves once the stop has been carried out; never rejects.
 */
export async function terminateWindows(
  child: ReturnType<typeof spawn>,
  tree: ChildProcessTree,
  deps: OwnConsoleDeps = {},
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const endRoot = () => {
    try {
      child.kill();
    } catch {
      // Exited meanwhile.
    }
  };
  // Read again once the table has been: the command's exit may be noted meanwhile.
  const stop = await stopOwnConsole(() => ({ pid, ...tree.root() }), endRoot, deps);
  if (stop === 'ended') {
    consoleStopped.add(child);
    return;
  }
  if (!consoleStopped.has(child) && (await mayEndTree(stop, child.spawnfile))) {
    await tree.kill({ platform: 'win32' }).catch(() => undefined);
    return;
  }
  if (stop === 'closed') consoleStopped.add(child);
  endRoot();
}

/** POSIX signals the command's process group, at once. */
function terminateGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): Promise<void> {
  if (child.pid === undefined) return Promise.resolve();
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
  return Promise.resolve();
}
