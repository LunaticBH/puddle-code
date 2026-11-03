import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import {
  findExecutable,
  getEnv,
  system32Path,
  type Environment,
} from '@puddle/shared/node/platform';

export interface DefaultShellOptions {
  platform?: NodeJS.Platform;
  /** `process.env` by default. */
  env?: Environment;
  /** Whether a path names an existing regular file; injectable for tests. */
  isFile?: (path: string) => boolean;
}

/**
 * The interactive shell for session terminals, shell tabs and the home shell
 * (docs/windows.md, decision 7).
 *
 * POSIX keeps `$SHELL`, falling back to `bash` on PATH.
 *
 * Windows has no `$SHELL` convention: Git Bash exports an MSYS path
 * (`/usr/bin/bash`) that CreateProcess cannot run, so SHELL is honoured only
 * when it is an absolute path to an existing `.exe`/`.com`. Otherwise:
 * PowerShell 7 (`pwsh.exe` on Path), then the Windows PowerShell 5.1 that
 * every supported Windows ships, then `%ComSpec%`, then System32's cmd.exe.
 */
export function defaultShell(opts: DefaultShellOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform !== 'win32') return env.SHELL ?? 'bash';
  const isFile = opts.isFile ?? existingFile;
  const configured = getEnv(env, 'SHELL', platform);
  if (configured && isWindowsExecutablePath(configured) && isFile(configured)) return configured;
  const pwsh = findExecutable('pwsh.exe', { platform, env });
  if (pwsh) return pwsh;
  const powershell = system32Path(win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe'), env);
  if (isFile(powershell)) return powershell;
  const comspec = getEnv(env, 'ComSpec', platform);
  if (comspec && isWindowsExecutablePath(comspec) && isFile(comspec)) return comspec;
  return system32Path('cmd.exe', env);
}

/** A drive-absolute or UNC path to a `.exe` or `.com`. */
function isWindowsExecutablePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(path) && /\.(?:exe|com)$/i.test(path);
}

function existingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The shell families the session hooks distinguish; `powershell`, `cmd` and `wsl` are Windows-only. */
export type ShellKind = 'zsh' | 'bash' | 'powershell' | 'cmd' | 'wsl' | 'other';

/**
 * Which hook a shell gets, by its file name. POSIX compares the basename
 * exactly, as it always has. Windows drops `.exe` and ignores case; there
 * `bash` means Git Bash, told apart from WSL's System32 `bash.exe` launcher,
 * whose Linux bash cannot read a Windows rc path. An MSYS zsh is not hooked.
 */
export function shellKind(
  shellPath: string,
  platform: NodeJS.Platform = process.platform,
): ShellKind {
  if (platform !== 'win32') {
    const name = posix.basename(shellPath);
    return name === 'zsh' || name === 'bash' ? name : 'other';
  }
  const name = win32
    .basename(shellPath)
    .replace(/\.exe$/i, '')
    .toLowerCase();
  if (name === 'pwsh' || name === 'powershell') return 'powershell';
  if (name === 'cmd') return 'cmd';
  if (name === 'wsl') return 'wsl';
  if (name !== 'bash') return 'other';
  return /(?:^|[\\/])(?:system32|sysnative|syswow64)$/i.test(win32.dirname(shellPath))
    ? 'wsl'
    : 'bash';
}
