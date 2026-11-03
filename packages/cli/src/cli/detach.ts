import { relayDaemonUpgradePrompt } from './daemon-upgrade-prompt.js';
import { requestInvitation } from '../lib/auth/launcher.js';
import { clientHome } from '../lib/paths.js';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { openBrowser } from '../lib/serve/browser.js';
import { sleep } from '../lib/transport/net.js';
import {
  checkCockpit,
  cockpitLogPath,
  isPidAlive,
  readCockpitRecord,
  removeCockpitRecord,
  type CockpitRecord,
} from '../lib/registry.js';
import { SshTransport } from '../lib/transport/ssh.js';
import { CliError, type Logger } from '../lib/types.js';

/**
 * Backgrounding a cockpit: `puddle launch` re-execs itself detached
 * (stdio to ~/.puddle/logs/cockpit-<target>.log), streams that log to the
 * launching terminal until the child's registry record turns ready, prints
 * the URL and exits — the terminal may then close. SSH auth warms the control
 * master before detaching; daemon update approval uses the parent terminal
 * through a private IPC pipe until startup completes.
 */

const COCKPIT_CHILD_ENV = 'PUDDLE_COCKPIT_CHILD';
/** How long a background start may take — first-time bootstrap downloads a release. */
const READY_TIMEOUT_MS = 300_000;

/** True inside the detached re-exec: run the cockpit, don't detach again. */
export function isCockpitChild(env: Record<string, string | undefined> = process.env): boolean {
  return env[COCKPIT_CHILD_ENV] === '1';
}

export function killHint(target: string): string {
  return target === 'local' ? 'stop it with: puddle kill' : `stop it with: puddle kill ${target}`;
}

export async function launchDetached(opts: {
  target: string;
  noBrowser: boolean;
  logger: Logger;
  /**
   * The argv the detached child runs; defaults to this process's own. Needed
   * when the launching command is not what the child should run — `refresh`
   * re-execs the rebuilt start/connect, not another refresh.
   */
  argv?: string[];
}): Promise<number> {
  const { target, logger } = opts;

  const existing = readCockpitRecord(target);
  if (existing !== null) {
    const liveness = await checkCockpit(existing);
    if (liveness === 'running' && existing.launcherPath) {
      logger.info(`a cockpit for ${target} is already running at ${existing.origin ?? '?'}`);
      await presentInvitation(existing, opts.noBrowser, logger);
      logger.info(killHint(target));
      return 0;
    }
    if (liveness === 'starting') {
      logger.info(
        `a cockpit for ${target} is already starting (pid ${existing.pid}) — puddle list to watch it`,
      );
      return 0;
    }
    if (liveness === 'running' && !existing.launcherPath) await terminateCockpit(existing);
    if (liveness === 'unverified') {
      // A live pid we cannot identify — never silently discard its record.
      throw new CliError(
        'already_running',
        `something holds the cockpit record for ${target} (pid ${existing.pid}) but did not answer at ${existing.origin ?? 'its recorded origin'}`,
        `if it is defunct: puddle kill ${target === 'local' ? 'local' : target}`,
      );
    }
    removeCockpitRecord(target); // dead — safe to prune
  }

  // Auth prompts need this terminal: open the ssh control master before
  // detaching, so the TTY-less child only ever attaches to a live master.
  if (target !== 'local') await new SshTransport(target).open();

  const logFile = cockpitLogPath(target);
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'w');
  const argv = opts.argv ?? process.argv.slice(2);
  const child = spawn(process.execPath, [process.argv[1] ?? '', ...argv], {
    detached: true,
    stdio: ['ignore', fd, fd, 'ipc'],
    env: { ...process.env, [COCKPIT_CHILD_ENV]: '1' },
  });
  closeSync(fd);
  child.unref();
  if (child.pid === undefined) {
    throw new CliError('cockpit_launch_failed', 'could not spawn the background cockpit process');
  }

  logger.info(`starting the cockpit for ${target} in the background…`);
  const stopPromptRelay = relayDaemonUpgradePrompt(child);
  let record: CockpitRecord | null;
  try {
    record = await followStartup(target, child.pid, logFile);
  } finally {
    stopPromptRelay();
  }

  if (record === null || record.status !== 'ready') {
    if (record?.status === 'error') {
      logger.warn(record.message ?? 'the cockpit failed to start');
      if (record.hint !== undefined) logger.info(`  hint: ${record.hint}`);
    } else {
      logger.warn(`the cockpit did not report ready — its log: ${logFile}`);
    }
    logger.info('  (a run that stays on this terminal: add --foreground)');
    // Clean up only OUR child's record — never a racing launch's.
    const current = readCockpitRecord(target);
    if (current !== null && current.pid === child.pid) removeCockpitRecord(target);
    return 1;
  }

  const arrow = target === 'local' ? '' : ` → ${target}`;
  logger.info(`Puddle cockpit at ${record.origin ?? '?'}${arrow} — running in the background`);
  await presentInvitation(record, opts.noBrowser, logger);
  logger.info(killHint(target));
  return 0;
}

/**
 * Tail the child's log to this terminal while polling its registry record;
 * resolves when the record leaves 'starting' (or the child dies / times out).
 */
async function followStartup(
  target: string,
  childPid: number,
  logFile: string,
): Promise<CockpitRecord | null> {
  let offset = 0;
  const relay = () => {
    try {
      const buf = readFileSync(logFile);
      if (buf.length > offset) {
        process.stderr.write(buf.subarray(offset));
        offset = buf.length;
      }
    } catch {
      // The child recreates the file only after we opened it; a read race is fine.
    }
  };
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    relay();
    const record = readCockpitRecord(target);
    if (record !== null && record.pid === childPid && record.status !== 'starting') return record;
    if (!isPidAlive(childPid)) {
      relay();
      const last = readCockpitRecord(target);
      return last !== null && last.pid === childPid ? last : null;
    }
    await sleep(200);
  }
  const last = readCockpitRecord(target);
  return last !== null && last.pid === childPid ? last : null;
}

/**
 * A UI-triggered refresh: hand the cockpit's replacement to a detached
 * `puddle refresh` process and let it take over — it stops THIS process, then
 * detaches a fresh cockpit on the same UI port. The child-env marker is
 * STRIPPED: the refresh process is a launcher, not a cockpit, even when
 * spawned from a detached cockpit that carries the marker itself. Its output
 * appends to the cockpit log, so the whole swap reads as one story there.
 */
export function spawnDetachedRefresh(target: string, argv: string[], refreshId: string): void {
  const logFile = cockpitLogPath(target);
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PUDDLE_REFRESH_ID: refreshId,
    PUDDLE_INTERNAL_REFRESH: '1',
  };
  delete env[COCKPIT_CHILD_ENV];
  const child = spawn(process.execPath, [process.argv[1] ?? '', ...argv], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env,
  });
  closeSync(fd);
  child.unref();
}

/** SIGTERM (the cockpit's clean-shutdown path), escalate to SIGKILL after 10s. */
export async function terminateCockpit(record: CockpitRecord): Promise<void> {
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch {
    // Already gone — the record removal below is all that's left to do.
  }
  // An attached daemon may spend up to five seconds draining its PTYs before
  // the cockpit closes its remaining resources, so leave headroom for that
  // graceful path before forcing the client process down.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isPidAlive(record.pid)) await sleep(100);
  if (isPidAlive(record.pid)) {
    try {
      process.kill(record.pid, 'SIGKILL');
    } catch {
      // Gone between the check and the kill.
    }
  }
  // Remove only the record we acted on: a new cockpit for the same target
  // may have registered while we waited (the old one's shutdown already
  // removed its own record) — its entry is not ours to delete.
  const current = readCockpitRecord(record.target);
  if (current === null || current.pid === record.pid) removeCockpitRecord(record.target);
}

async function presentInvitation(
  record: CockpitRecord,
  noBrowser: boolean,
  logger: Logger,
): Promise<void> {
  if (process.env.PUDDLE_INTERNAL_REFRESH === '1') return;
  if (!record.launcherPath)
    throw new CliError('cockpit_launch_failed', 'Run puddle refresh to replace this older cockpit');
  const url = await requestInvitation(clientHome(), record.launcherPath);
  if (noBrowser) logger.info(`open: ${url}`);
  else openBrowser(url);
}
