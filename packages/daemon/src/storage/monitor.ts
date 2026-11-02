import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StorageStatus } from '@puddle/shared';
import { ApiError } from '../http/errors.js';
import { isDatabaseFull, isStorageFull } from './errors.js';

const WARNING_BYTES = 1024 ** 3;
const CRITICAL_BYTES = 256 * 1024 ** 2;
const WARNING_INODES = 10_000;
const CRITICAL_INODES = 1000;
const POLL_MS = 30_000;

type Volume = StorageStatus['volumes'][number];
type Probe = (path: string) => Promise<Volume>;

/** statfs uses space available to this user, including reserved-block restrictions. */
export async function inspectStorage(path: string): Promise<Volume> {
  let existing = path;
  for (;;) {
    try {
      const fs = await statfs(existing);
      const bytes = Math.max(0, fs.bavail * fs.bsize);
      // APFS and some network filesystems do not advertise an inode limit.
      const inodes = fs.files > 0 ? Math.max(0, fs.ffree) : null;
      const level =
        bytes < CRITICAL_BYTES || (inodes !== null && inodes < CRITICAL_INODES)
          ? 'critical'
          : bytes < WARNING_BYTES || (inodes !== null && inodes < WARNING_INODES)
            ? 'warning'
            : 'ok';
      return { path, available_bytes: bytes, available_inodes: inodes, level };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && dirname(existing) !== existing) {
        existing = dirname(existing);
        continue;
      }
      return { path, available_bytes: null, available_inodes: null, level: 'unknown' };
    }
  }
}

/** Advisory polling plus fresh admission checks; actual write errors remain authoritative. */
export class StorageMonitor {
  private volumes = new Map<string, Volume>();
  private checkedAt: string | null = null;
  private readonly degradedLogs = new Set<string>();
  private databaseDegraded = false;
  private pendingRuntimeCount = 0;
  private disposed = false;
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private databaseProbe: (() => void) | null = null;
  private readonly probing = new Map<string, Promise<Volume>>();

  constructor(
    private readonly paths: () => string[],
    private readonly probe: Probe = inspectStorage,
  ) {}

  setDatabaseProbe(probe: () => void): void {
    this.databaseProbe = probe;
  }
  setLogsDegraded(value: boolean, source = 'logs'): void {
    if (value) this.degradedLogs.add(source);
    else this.degradedLogs.delete(source);
  }
  setPendingRuntimeCount(count: number): void {
    this.pendingRuntimeCount = count;
  }
  noteFailure(error: unknown): void {
    if (isDatabaseFull(error)) this.databaseDegraded = true;
  }
  status(): StorageStatus {
    return {
      checked_at: this.checkedAt,
      volumes: [...this.volumes.values()],
      logs_degraded: this.degradedLogs.size > 0,
      database_degraded: this.databaseDegraded || this.pendingRuntimeCount > 0,
    };
  }
  start(): void {
    this.disposed = false;
    this.timer = setInterval(() => {
      void this.refresh().catch((error: unknown) => console.warn('Storage check failed:', error));
    }, POLL_MS);
    this.timer.unref();
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshCore().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  private async refreshCore(): Promise<void> {
    const next = new Map<string, Volume>();
    // Sequential probes yield to the event loop without flooding large hosts with I/O.
    for (const path of new Set(this.paths())) next.set(path, await this.inspect(path));
    if (this.disposed) return;
    this.volumes = next;
    this.checkedAt = new Date().toISOString();
    if (this.databaseDegraded && this.databaseProbe) {
      try {
        this.databaseProbe();
        this.databaseDegraded = false;
      } catch (error) {
        if (!isStorageFull(error)) console.warn('Database recovery probe failed:', error);
      }
    }
  }

  private async inspect(path: string): Promise<Volume> {
    let pending = this.probing.get(path);
    if (!pending) {
      pending = this.probe(path).finally(() => {
        this.probing.delete(path);
      });
      this.probing.set(path, pending);
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<Volume>((resolve) => {
          timeout = setTimeout(
            () =>
              resolve({ path, available_bytes: null, available_inodes: null, level: 'unknown' }),
            3000,
          );
        }),
      ]);
    } catch {
      return { path, available_bytes: null, available_inodes: null, level: 'unknown' };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async assertAdmission(paths: string[]): Promise<void> {
    if (this.status().database_degraded) throw storageUnavailable();
    for (const path of new Set(paths)) {
      const volume = await this.inspect(path);
      this.volumes.set(path, volume);
      this.checkedAt = new Date().toISOString();
      if (volume.level === 'critical') {
        throw new ApiError(
          507,
          'storage_full',
          `Storage is critically low at ${path}. Free space or inodes before starting another session or worktree.`,
        );
      }
      if (volume.level === 'unknown') {
        throw new ApiError(
          503,
          'storage_unavailable',
          `Could not check storage at ${path}. Try again before starting another session or worktree.`,
        );
      }
    }
  }
}

export function storageUnavailable(): ApiError {
  return new ApiError(
    507,
    'storage_full',
    'Storage is full. The operation could not be saved; free space and check its state before trying again.',
  );
}
