import {
  execFile,
  spawn,
  type ChildProcess,
  type ExecFileOptions,
  type SpawnOptions,
} from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { resolveSpawn, setEnv, type Environment } from '@puddle/shared/node/platform';

const execFileAsync = promisify(execFile);

/**
 * Starting an agent CLI outside a PTY: auth and version probes, `claude -p
 * /usage`, `opencode export` and the Codex app-server (docs/windows.md,
 * decision 9). PTY launches resolve their executable in the PTY manager.
 *
 * POSIX passes the bare name and the options through untouched. Windows
 * resolves the name on PATH only, never in the child's working directory,
 * where a repository could plant `codex.exe`; unwraps npm-style `.cmd` shims
 * into `node.exe <script>`, since Node refuses to start a batch file without
 * a shell; and hides the console window that every console child of a
 * detached daemon would otherwise flash open.
 */
export interface AgentSpawnSpec<T> {
  file: string;
  args: string[];
  options: T & { windowsHide?: boolean; windowsVerbatimArguments?: boolean };
}

export function agentSpawnSpec<T extends { env?: Environment }>(
  file: string,
  args: readonly string[],
  options: T,
  platform: NodeJS.Platform = process.platform,
): AgentSpawnSpec<T> {
  if (platform !== 'win32') return { file, args: [...args], options };
  const env = options.env ?? process.env;
  const resolved = resolveSpawn(file, args, { platform, env });
  if (!win32.isAbsolute(resolved.file)) {
    // Spawning the bare name would let libuv search the working directory first.
    throw Object.assign(new Error(`spawn ${file} ENOENT`), {
      code: 'ENOENT',
      syscall: 'spawn',
      path: file,
    });
  }
  let childEnv: Environment | undefined;
  if (resolved.env) {
    childEnv = { ...env };
    for (const [key, value] of Object.entries(resolved.env)) setEnv(childEnv, key, value, platform);
  }
  return {
    file: resolved.file,
    args: resolved.args,
    options: {
      ...options,
      ...(childEnv ? { env: childEnv } : {}),
      windowsHide: true,
      ...(resolved.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    },
  };
}

/** `execFile` for an agent CLI, resolving to its decoded output; see {@link agentSpawnSpec}. */
export async function execAgent(
  file: string,
  args: readonly string[],
  options: Omit<ExecFileOptions, 'encoding'> = {},
  platform: NodeJS.Platform = process.platform,
): Promise<{ stdout: string; stderr: string }> {
  const spec = agentSpawnSpec(file, args, { ...options, encoding: 'utf8' as const }, platform);
  return execFileAsync(spec.file, spec.args, spec.options);
}

/** `spawn` for an agent CLI; throws ENOENT on Windows when it is not on PATH. */
export function spawnAgent(
  file: string,
  args: readonly string[],
  options: SpawnOptions,
  platform: NodeJS.Platform = process.platform,
): ChildProcess {
  const spec = agentSpawnSpec(file, args, options, platform);
  return spawn(spec.file, spec.args, spec.options);
}

/**
 * `{ ...base, ...overrides }` for an agent child's environment. Windows keys
 * are case-insensitive, so there each override replaces every other spelling
 * of its key rather than adding a duplicate the child resolves arbitrarily.
 */
export function agentEnv(
  overrides: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  base: Environment = process.env,
): Environment {
  if (platform !== 'win32') return { ...base, ...overrides };
  const env: Environment = { ...base };
  for (const [key, value] of Object.entries(overrides)) setEnv(env, key, value, platform);
  return env;
}
