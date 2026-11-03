import { execFile } from 'node:child_process';
import { system32Path, type Environment } from './environment.js';

/**
 * Whether `pid` names a live process, by a signal-0 probe. POSIX keeps the
 * rule every existing caller applies (the CLI registry, the desktop askpass
 * helper and `kill -0` over SSH): any failure, EPERM included, reads as not
 * alive. On Windows EPERM means the process exists but is another user's or
 * protected, so it is alive. Pids that are not positive integers are never
 * alive: signal 0 to 0 or -1 would probe a process group instead.
 */
export function isPidAlive(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface KillProcessTreeOptions {
  platform?: NodeJS.Platform;
  /** Bound on waiting for taskkill.exe; 5 s by default. */
  timeoutMs?: number;
  /** Locates `%SystemRoot%`; `process.env` by default. */
  env?: Environment;
}

/**
 * Forcibly stops `pid` and its descendants, resolving whether or not the
 * process existed. Windows runs `taskkill.exe /PID <pid> /T /F` from
 * System32. POSIX sends SIGKILL to the process group `pid` leads and then to
 * `pid` itself, which only reaches descendants that stayed in that group;
 * existing POSIX callers keep their own signal sequences.
 */
export function killProcessTree(pid: number, opts: KillProcessTreeOptions = {}): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.reject(new RangeError(`Invalid process id: ${pid}`));
  }
  if ((opts.platform ?? process.platform) !== 'win32') {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // Already gone, or not a group leader.
      }
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile(
      system32Path('taskkill.exe', opts.env),
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: opts.timeoutMs ?? 5_000 },
      // Exit status 128 means no such process: the outcome callers want.
      () => resolve(),
    );
  });
}
