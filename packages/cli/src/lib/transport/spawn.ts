import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { resolveSpawn, setEnv } from '@puddle/shared/node/platform';

/**
 * `spawn` for the ssh and scp clients. POSIX spawns exactly as given. Windows
 * resolves the program through PATHEXT and unwraps npm-style `.cmd` shims to
 * `node <script>` (docs/windows.md, decision 9), so a configured wrapper
 * works and arguments never pass through cmd.exe.
 */
export function spawnClient(
  file: string,
  args: string[],
  options: SpawnOptions,
  platform: NodeJS.Platform = process.platform,
): ChildProcess {
  if (platform !== 'win32') return spawn(file, args, options);
  const resolved = resolveSpawn(file, args, { platform });
  let env = options.env;
  if (resolved.env) {
    env = { ...(options.env ?? process.env) };
    for (const [name, value] of Object.entries(resolved.env)) setEnv(env, name, value, platform);
  }
  return spawn(resolved.file, resolved.args, {
    ...options,
    ...(env ? { env } : {}),
    ...(resolved.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}
