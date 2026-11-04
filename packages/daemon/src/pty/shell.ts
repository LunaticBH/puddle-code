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
 * Windows runs PowerShell, the only shell Puddle uses there. SHELL counts
 * only when it is an absolute path to an existing `pwsh.exe` or
 * `powershell.exe`, which keeps a PowerShell off Path (a preview build)
 * selectable. Otherwise PowerShell 7 (`pwsh.exe` on Path), then the Windows
 * PowerShell 5.1 that every supported Windows ships and cannot remove.
 */
export function defaultShell(opts: DefaultShellOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform !== 'win32') return env.SHELL ?? 'bash';
  const isFile = opts.isFile ?? existingFile;
  const configured = getEnv(env, 'SHELL', platform);
  if (
    configured &&
    isWindowsExecutablePath(configured) &&
    shellKind(configured, platform) === 'powershell' &&
    isFile(configured)
  ) {
    return configured;
  }
  const pwsh = findExecutable('pwsh.exe', { platform, env });
  if (pwsh) return pwsh;
  return system32Path(win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe'), env);
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

/** The shell families the session hooks distinguish; `powershell` is Windows-only. */
export type ShellKind = 'zsh' | 'bash' | 'powershell' | 'other';

/**
 * Which hook a shell gets, by its file name. POSIX compares the basename
 * exactly, as it always has. Windows drops `.exe`, ignores case and
 * recognises PowerShell only: any other programme there runs unhooked.
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
  return name === 'pwsh' || name === 'powershell' ? 'powershell' : 'other';
}
