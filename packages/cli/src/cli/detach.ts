import { relayDaemonUpgradePrompt } from './daemon-upgrade-prompt.js';
import { requestCockpitShutdown, requestInvitation } from '../lib/auth/launcher.js';
import { clientHome, prepareClientHome } from '../lib/paths.js';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { openBrowser } from '../lib/serve/browser.js';
import { sleep } from '../lib/transport/net.js';
import {
  checkCockpit,
  cockpitLogPath,
  isPidAlive,
  isRecordedProcess,
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
/** The SSH host's platform as the launcher found it: `win32` for a Windows host. */
const REMOTE_PLATFORM_ENV = 'PUDDLE_REMOTE_PLATFORM';
/** How long a background start may take — first-time bootstrap downloads a release. */
const READY_TIMEOUT_MS = 300_000;

/** True inside the detached re-exec: run the cockpit, don't detach again. */
export function isCockpitChild(env: Record<string, string | undefined> = process.env): boolean {
  return env[COCKPIT_CHILD_ENV] === '1';
}

/**
 * Inside the detached re-exec: the platform the launcher detected for its
 * SSH host, so the child never sends a Windows host POSIX `true` again.
 */
export function launcherRemotePlatform(
  env: Record<string, string | undefined> = process.env,
): 'win32' | undefined {
  return isCockpitChild(env) && env[REMOTE_PLATFORM_ENV] === 'win32' ? 'win32' : undefined;
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
  // Windows OpenSSH has no master, so the background child must authenticate
  // every connection itself, without prompting.
  let remotePlatform: 'win32' | undefined;
  if (target !== 'local') {
    if (process.platform === 'win32') remotePlatform = await requirePromptlessSsh(target);
    else {
      const ssh = new SshTransport(target);
      await ssh.open();
      remotePlatform = ssh.remotePlatform;
    }
  }

  const logFile = cockpitLogPath(target);
  // Often the first write to a new home: on Windows it must start private.
  prepareClientHome();
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'w');
  const argv = opts.argv ?? process.argv.slice(2);
  const child = spawn(process.execPath, [process.argv[1] ?? '', ...argv], {
    detached: true,
    // A console-less child would open a window for every console program it
    // starts (ssh, git); hidden, it starts them hidden too. No-op elsewhere.
    windowsHide: true,
    stdio: ['ignore', fd, fd, 'ipc'],
    env: {
      ...process.env,
      [COCKPIT_CHILD_ENV]: '1',
      ...(remotePlatform ? { [REMOTE_PLATFORM_ENV]: remotePlatform } : {}),
    },
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
  prepareClientHome();
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PUDDLE_REFRESH_ID: refreshId,
    PUDDLE_INTERNAL_REFRESH: '1',
  };
  delete env[COCKPIT_CHILD_ENV];
  delete env[REMOTE_PLATFORM_ENV];
  const child = spawn(process.execPath, [process.argv[1] ?? '', ...argv], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env,
  });
  closeSync(fd);
  child.unref();
}

/**
 * The background cockpit has no terminal, and on Windows no ssh master to
 * reuse: refuse up front unless key or agent authentication works without
 * a prompt, instead of letting every reconnect fail in the log. Resolves
 * with the platform the connection found.
 */
async function requirePromptlessSsh(target: string): Promise<'win32' | undefined> {
  try {
    const ssh = new SshTransport(target, { batchMode: true });
    await ssh.open();
    return ssh.remotePlatform;
  } catch (err) {
    // A host that answered but cannot be driven (ConstrainedLanguage) says so itself.
    if (!(err instanceof CliError) || err.code !== 'ssh_unreachable') throw err;
    throw new CliError(
      'ssh_unreachable',
      `a background cockpit on Windows needs SSH to ${target} to work without prompts`,
      'add an SSH key (and start the ssh-agent service), or stay attached with --foreground',
    );
  }
}

/**
 * SIGTERM (the cockpit's clean-shutdown path), escalate to SIGKILL after 10s.
 * Windows cannot deliver SIGTERM (process.kill is TerminateProcess there), so
 * it asks over the launcher pipe instead, and forces only a process that is
 * provably the recorded cockpit: pids are recycled quickly there.
 */
export async function terminateCockpit(
  record: CockpitRecord,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') return terminateWindowsCockpit(record);
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
  removeRecordWeActedOn(record);
}

async function terminateWindowsCockpit(record: CockpitRecord): Promise<void> {
  const identity = await isRecordedProcess(record, 'win32');
  if (identity === false || !isPidAlive(record.pid, 'win32')) return removeRecordWeActedOn(record);
  // Without the process table, only a cockpit that echoes its nonce is provably ours.
  if (identity === null && (await checkCockpit(record, 'win32')) !== 'running') {
    throw new CliError(
      'cockpit_launch_failed',
      `cannot confirm that pid ${record.pid} is the cockpit for ${record.target}`,
      'stop it in Task Manager if it is, then run: puddle list',
    );
  }
  if (record.launcherPath) {
    await requestCockpitShutdown(clientHome(), record.launcherPath).catch(() => undefined);
  }
  // Leave the same headroom as the POSIX path for an attached daemon's drain.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isPidAlive(record.pid, 'win32')) await sleep(100);
  if (isPidAlive(record.pid, 'win32')) {
    try {
      // TerminateProcess; its ssh.exe children share libuv's kill-on-close job.
      process.kill(record.pid);
    } catch {
      // Gone between the check and the kill.
    }
  }
  removeRecordWeActedOn(record);
}

/**
 * Remove only the record we acted on: a new cockpit for the same target may
 * have registered while we waited (the old one's shutdown already removed its
 * own record) — its entry is not ours to delete.
 */
function removeRecordWeActedOn(record: CockpitRecord): void {
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
