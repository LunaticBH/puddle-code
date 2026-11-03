import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { atomicPrivateJson, privateDirectory } from '@puddle/shared/node';
import {
  isPidAlive as processAlive,
  listWindowsProcesses,
  type WindowsProcess,
} from '@puddle/shared/node/platform';
import { join } from 'node:path';
import { clientHome } from './paths.js';

/**
 * The cockpit registry: one JSON file per target under ~/.puddle/cockpits/,
 * written by the running cockpit process (background or foreground alike) so
 * `puddle list` and `puddle kill` can find it after the launching terminal is
 * long gone. A record is a claim, not a guarantee — liveness is verified
 * against the process AND the UI server's nonce, never assumed (the lesson
 * of the daemon-port collision: identity, not reachability).
 */

export interface CockpitRecord {
  /** 'local', or the user@host argument the cockpit fronts. */
  target: string;
  pid: number;
  status: 'starting' | 'ready' | 'error';
  startedAt: string;
  cliVersion: string;
  /** Set once ready. */
  origin?: string;
  /** Protected launcher IPC address; contains no credentials. */
  launcherPath?: string;
  /** Echoed by the UI server as X-Puddle-Cockpit; proves origin is this cockpit. */
  nonce?: string;
  /** `cockpit` when the remote daemon is held by this process's SSH channel. */
  daemonLifetime?: 'persistent' | 'cockpit';
  logFile?: string;
  /** Set on status 'error' so the launcher can relay the failure. */
  message?: string;
  hint?: string;
}

/**
 * 'dead' (pid gone) is the only state safe to prune. 'unverified' — pid
 * alive but the origin did not echo the nonce (a recycled pid, a stranger on
 * the port, or just a cockpit too busy to answer in time) — must never be
 * auto-deleted: the record is the only handle to a possibly-live process.
 */
export type CockpitLiveness = 'running' | 'starting' | 'unverified' | 'dead';

function cockpitsDir(env?: Record<string, string | undefined>): string {
  return join(clientHome(env), 'cockpits');
}

/** Filesystem-safe name for a target ('local' or user@host). */
function slug(target: string): string {
  return target.replace(/[^A-Za-z0-9@._-]/g, '_');
}

export function cockpitRecordPath(target: string): string {
  return join(cockpitsDir(), `${slug(target)}.json`);
}

/** Where a cockpit's own output lands when it runs detached. */
export function cockpitLogPath(target: string): string {
  return join(clientHome(), 'logs', `cockpit-${slug(target)}.log`);
}

export function writeCockpitRecord(record: CockpitRecord): void {
  privateDirectory(cockpitsDir());
  atomicPrivateJson(cockpitRecordPath(record.target), sanitise(record));
}

export function readCockpitRecord(target: string): CockpitRecord | null {
  try {
    const record = JSON.parse(readFileSync(cockpitRecordPath(target), 'utf8')) as CockpitRecord;
    if ('browserUrl' in record) writeCockpitRecord(record);
    return sanitise(record);
  } catch {
    return null;
  }
}

export function removeCockpitRecord(target: string): void {
  rmSync(cockpitRecordPath(target), { force: true });
}

export function listCockpitRecords(): CockpitRecord[] {
  let names: string[];
  try {
    names = readdirSync(cockpitsDir());
  } catch {
    return [];
  }
  const records: CockpitRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(readFileSync(join(cockpitsDir(), name), 'utf8')) as CockpitRecord;
      if ('browserUrl' in record) writeCockpitRecord(record);
      records.push(sanitise(record));
    } catch {
      // A half-written or corrupt record reads as absent; verification would
      // have discarded it anyway.
    }
  }
  return records.sort((a, b) => a.target.localeCompare(b.target));
}

/**
 * Signal-0 probe; embeddable (no TTY, no console) so it may live here. On
 * Windows EPERM means alive: the process exists but runs elevated or as
 * another user.
 */
export function isPidAlive(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  return processAlive(pid, platform);
}

/**
 * Windows recycles pids quickly, so a live pid proves little there: the
 * process must also have been created no later than the record it claims
 * (with a little slack for clock rounding). Null when the process table is
 * unavailable. POSIX trusts the pid, as it always has.
 */
export async function isRecordedProcess(
  record: Pick<CockpitRecord, 'pid' | 'startedAt'>,
  platform: NodeJS.Platform = process.platform,
  list: () => Promise<readonly WindowsProcess[]> = listWindowsProcesses,
): Promise<boolean | null> {
  if (platform !== 'win32') return true;
  let processes: readonly WindowsProcess[];
  try {
    processes = await list();
  } catch {
    return null;
  }
  const entry = processes.find((candidate) => candidate.pid === record.pid);
  const started = Date.parse(record.startedAt);
  return (
    entry !== undefined &&
    entry.createdAtMs !== null &&
    Number.isFinite(started) &&
    entry.createdAtMs <= started + 2_000
  );
}

/**
 * Is the record's cockpit actually there? 'running' requires the process to
 * be alive AND the recorded origin to echo the recorded nonce — identity,
 * never reachability alone. On Windows a pid that now names a younger
 * process means the cockpit is gone.
 */
export async function checkCockpit(
  record: CockpitRecord,
  platform: NodeJS.Platform = process.platform,
): Promise<CockpitLiveness> {
  if (!isPidAlive(record.pid, platform)) return 'dead';
  if ((await isRecordedProcess(record, platform)) === false) return 'dead';
  if (record.status === 'starting') return 'starting';
  if (record.status !== 'ready' || record.origin === undefined || record.nonce === undefined) {
    return 'unverified';
  }
  try {
    const res = await fetch(`${record.origin}/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(1500),
    });
    return res.headers.get('x-puddle-cockpit') === record.nonce ? 'running' : 'unverified';
  } catch {
    return 'unverified';
  }
}

function sanitise(record: CockpitRecord): CockpitRecord {
  const {
    target,
    pid,
    status,
    startedAt,
    cliVersion,
    origin,
    nonce,
    launcherPath,
    daemonLifetime,
    logFile,
    message,
    hint,
  } = record;
  return {
    target,
    pid,
    status,
    startedAt,
    cliVersion,
    origin,
    nonce,
    launcherPath,
    daemonLifetime,
    logFile,
    message,
    hint,
  };
}
