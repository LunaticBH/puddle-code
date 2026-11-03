import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { stopWindowsDaemon } from './windows-daemon.js';
import { CliError, type Logger, silentLogger } from '../types.js';

const execute = promisify(execFile);

/**
 * `puddle remove daemon` and its worktree sweep on this Windows machine: the
 * POSIX scripts' steps in Node (docs/windows.md, decision 4). Windows refuses
 * to delete files a process still has open, so the daemon is stopped and
 * awaited first, and anything still locked afterwards is reported as kept
 * rather than failing halfway.
 */

/** Worktrees carrying work a purge would destroy: dirty, or unpushed commits. */
export async function sweepWindowsWorktrees(home: string): Promise<string[]> {
  const root = join(home, 'worktrees');
  const dirty: string[] = [];
  for (const repo of entries(root)) {
    for (const name of entries(join(root, repo))) {
      const dir = join(root, repo, name);
      // A linked worktree's .git is a file; either form marks a checkout.
      if (!existsSync(join(dir, '.git'))) continue;
      const [status, unpushed] = await Promise.all([
        git(dir, ['status', '--porcelain']),
        git(dir, ['log', '--branches', '--not', '--remotes', '--oneline']),
      ]);
      if (status !== '' || unpushed !== '') dirty.push(dir);
    }
  }
  return dirty;
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Trimmed stdout; a failure reads as "nothing to report", as in the POSIX sweep. */
async function git(dir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execute('git', ['-C', dir, ...args], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function removeWindowsDaemon(
  home: string,
  opts: { purge: boolean; logger?: Logger },
): Promise<void> {
  const logger = opts.logger ?? silentLogger;
  const say = (message: string) => logger.info(`puddled remove: ${message}`);
  await disableConnector(home);
  await stopWindowsDaemon(home, { logger });

  const targets = opts.purge
    ? [home]
    : ['bin', 'cache', 'runtime.json', 'supervisor', 'puddled.pid'].map((name) => join(home, name));
  const kept: string[] = [];
  for (const target of targets) {
    try {
      // Junctions are removed, never followed into their targets.
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      kept.push(`${target} (${(err as NodeJS.ErrnoException).code ?? 'locked'})`);
    }
  }
  for (const entry of kept) logger.warn(`puddled remove: kept ${entry} — a process still uses it`);
  if (opts.purge) say(kept.length === 0 ? `deleted ${home}` : `deleted what was free in ${home}`);
  else say(`removed the install; data kept under ${home}`);
}

/** Persist remote disable first, as the POSIX removal does; failure aborts the removal. */
async function disableConnector(home: string): Promise<void> {
  const current = join(home, 'bin', 'current');
  const script = join(current, 'daemon', 'connector.mjs');
  if (!existsSync(script) || !existsSync(join(home, 'remote'))) return;
  if (!existsSync(join(current, 'CONNECTOR_PROTOCOL'))) return;
  try {
    await execute(join(current, 'bin', 'node.exe'), [script, '--disable-all'], {
      windowsHide: true,
      timeout: 60_000,
      env: { ...process.env, PUDDLE_HOME: home },
    });
  } catch {
    throw new CliError(
      'not_installed',
      'the removal failed on this machine: remote access could not be disabled',
      'nothing was removed; retry the removal',
    );
  }
}
