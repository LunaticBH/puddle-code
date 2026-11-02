import { constants, lstatSync, renameSync, type Stats } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const COPY_BYTES = 64 * 1024;

export interface LogRetentionOptions {
  logsDir: string;
  retentionDays: number;
  /** Retain exactly what LogStore.readTail can return, including a partial UTF-8 prefix. */
  replayBytes: number;
  /** Must be synchronous: the final check and rename run in one event-loop turn. */
  isBusy(stream: string, term: string): boolean;
  now?: number;
  stopped?: () => boolean;
}

export interface LogRetentionResult {
  compacted: number;
  reclaimedBytes: number;
  skipped: number;
  failed: number;
}

function unchanged(before: Stats, after: Stats): boolean {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}
function sameDirectory(path: string, before: Stats): boolean {
  const after = lstatSync(path);
  return (
    after.isDirectory() &&
    !after.isSymbolicLink() &&
    before.dev === after.dev &&
    before.ino === after.ino
  );
}

/**
 * Age out bulk PTY recordings, preserving every byte existing restoration and
 * hand-off readers can consume. Snapshots, shell history and terminal ids stay.
 * Diagnostic logs at the root belong to other processes and are never swept.
 */
export async function compactTerminalLogs(
  options: LogRetentionOptions,
): Promise<LogRetentionResult> {
  const result: LogRetentionResult = { compacted: 0, reclaimedBytes: 0, skipped: 0, failed: 0 };
  if (options.retentionDays === 0) return result;
  if (
    !Number.isInteger(options.retentionDays) ||
    options.retentionDays < 0 ||
    !Number.isInteger(options.replayBytes) ||
    options.replayBytes < 1024
  )
    throw new Error('Invalid terminal log retention settings');
  const root = await lstat(options.logsDir);
  if (!root.isDirectory() || root.isSymbolicLink()) return result;
  const cutoff = (options.now ?? Date.now()) - options.retentionDays * DAY_MS;
  for (const stream of await readdir(options.logsDir, { withFileTypes: true })) {
    if (options.stopped?.()) break;
    if (!stream.isDirectory() || stream.isSymbolicLink()) continue;
    const directory = join(options.logsDir, stream.name);
    let directoryStat: Stats;
    let names: string[];
    try {
      directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue;
      names = await readdir(directory);
    } catch {
      result.failed++;
      continue;
    }
    for (const name of names) {
      if (options.stopped?.()) return result;
      if (!name.endsWith('.log')) continue;
      const term = name.slice(0, -4);
      const file = join(directory, name);
      let temporary: string | null = null;
      try {
        if (options.isBusy(stream.name, term)) {
          result.skipped++;
          continue;
        }
        const before = await lstat(file);
        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          before.mtimeMs >= cutoff ||
          before.size <= options.replayBytes
        ) {
          result.skipped++;
          continue;
        }
        const source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!unchanged(before, await source.stat())) {
            result.skipped++;
            continue;
          }
          temporary = `${file}.retention-${randomUUID()}`;
          const target = await open(temporary, 'wx', before.mode & 0o777);
          try {
            const buffer = Buffer.alloc(Math.min(COPY_BYTES, options.replayBytes));
            let remaining = options.replayBytes;
            let position = before.size - remaining;
            while (remaining > 0) {
              if (options.stopped?.() || options.isBusy(stream.name, term)) break;
              const { bytesRead } = await source.read(
                buffer,
                0,
                Math.min(buffer.length, remaining),
                position,
              );
              if (bytesRead === 0) break;
              let written = 0;
              while (written < bytesRead) {
                const { bytesWritten } = await target.write(buffer, written, bytesRead - written);
                if (bytesWritten === 0) throw new Error('Terminal log compaction made no progress');
                written += bytesWritten;
              }
              remaining -= bytesRead;
              position += bytesRead;
            }
            if (remaining !== 0) {
              result.skipped++;
              continue;
            }
            await target.utimes(before.atime, before.mtime);
            await target.sync();
          } finally {
            await target.close();
          }
          // No await between these guards and rename: a daemon PTY cannot reopen
          // the log after the busy check but before its descriptor is replaced.
          if (
            options.stopped?.() ||
            options.isBusy(stream.name, term) ||
            !sameDirectory(options.logsDir, root) ||
            !sameDirectory(directory, directoryStat) ||
            !unchanged(before, lstatSync(file))
          ) {
            result.skipped++;
            continue;
          }
          renameSync(temporary, file);
          temporary = null;
          result.compacted++;
          result.reclaimedBytes += before.size - options.replayBytes;
        } finally {
          await source.close();
        }
      } catch {
        result.failed++;
      } finally {
        if (temporary) await unlink(temporary).catch(() => {});
      }
    }
  }
  return result;
}

/** Coalesce upkeep; shutdown waits for the bounded in-flight copy to leave the filesystem. */
export class LogRetention {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<LogRetentionResult> | null = null;
  private stopped = false;
  constructor(private readonly options: () => Omit<LogRetentionOptions, 'stopped'>) {}
  start(): void {
    this.stopped = false;
    const sweep = () => {
      void this.sweep().catch((error: unknown) =>
        console.warn('Terminal log retention failed:', error),
      );
    };
    this.timer = setInterval(sweep, 60 * 60 * 1000);
    this.timer.unref();
    sweep();
  }
  sweep(): Promise<LogRetentionResult> {
    if (!this.running)
      this.running = Promise.resolve()
        .then(() =>
          compactTerminalLogs({
            ...this.options(),
            stopped: () => this.stopped,
          }),
        )
        .finally(() => {
          this.running = null;
        });
    return this.running;
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
  }
}
