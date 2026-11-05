import { lstatSync, readlinkSync, statSync } from 'node:fs';
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
  /** Whether a path is the Store PowerShell's App Execution Alias; injectable for tests. */
  isPowerShellAlias?: (path: string) => boolean;
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
 * selectable. Otherwise PowerShell 7 (`pwsh.exe` on Path, else the
 * Microsoft Store's, see storePowerShell), then the Windows PowerShell 5.1
 * that every supported Windows ships and cannot remove.
 */
export function defaultShell(opts: DefaultShellOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform !== 'win32') return env.SHELL ?? 'bash';
  const isFile = opts.isFile ?? existingFile;
  const isAlias = opts.isPowerShellAlias ?? isPowerShellAppAlias;
  const configured = getEnv(env, 'SHELL', platform);
  if (
    configured &&
    isWindowsExecutablePath(configured) &&
    shellKind(configured, platform) === 'powershell' &&
    (isFile(configured) || isAlias(configured))
  ) {
    return configured;
  }
  const pwsh = findExecutable('pwsh.exe', { platform, env }) ?? storePowerShell(env, isAlias);
  if (pwsh) return pwsh;
  return system32Path(win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe'), env);
}

/** The file-system reads an alias check makes; injectable for tests. */
export interface AliasProbe {
  stat(path: string): unknown;
  lstat(path: string): { isSymbolicLink(): boolean };
  readlink(path: string): string;
}

const nodeProbe: AliasProbe = { stat: statSync, lstat: lstatSync, readlink: readlinkSync };

/**
 * Whether `path` is the App Execution Alias of the Microsoft Store's
 * PowerShell 7 (`%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`), which the
 * existence checks above refuse: an alias cannot be stat'ed (EACCES), though
 * CreateProcess, ConPTY and libuv start it. Node reads it as a symbolic link
 * to the packaged program, so only a `pwsh.exe` alias whose target is the
 * `pwsh.exe` of a `Microsoft.PowerShell` package counts, never another
 * Store stub (the App Installer's python.exe redirector among them).
 */
export function isPowerShellAppAlias(path: string, probe: AliasProbe = nodeProbe): boolean {
  if (win32.basename(path).toLowerCase() !== 'pwsh.exe') return false;
  try {
    probe.stat(path);
    return false; // A program file, which the ordinary checks accept.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EACCES') return false;
  }
  try {
    if (!probe.lstat(path).isSymbolicLink()) return false;
    const target = probe.readlink(path);
    return (
      win32.basename(target).toLowerCase() === 'pwsh.exe' &&
      /^Microsoft\.PowerShell(?:Preview)?_/i.test(win32.basename(win32.dirname(target)))
    );
  } catch {
    return false;
  }
}

/**
 * PowerShell 7 installed from the Microsoft Store: its App Execution Alias,
 * in the folder Windows keeps the user's aliases in (and puts on Path).
 * Turning the alias off in Settings removes it.
 */
export function storePowerShell(
  env: Environment,
  isAlias: (path: string) => boolean = isPowerShellAppAlias,
): string | null {
  const localAppData = getEnv(env, 'LOCALAPPDATA', 'win32');
  if (!localAppData || !/^[A-Za-z]:[\\/]/.test(localAppData)) return null;
  const alias = win32.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe');
  return isAlias(alias) ? alias : null;
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
