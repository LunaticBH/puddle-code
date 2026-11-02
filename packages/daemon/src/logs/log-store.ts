import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { isStorageFull } from '../storage/errors.js';

const FLUSH_MS = 100;
const PER_TERM_BYTES = 256 * 1024;
const TOTAL_PENDING_BYTES = 8 * 1024 * 1024;

/** Bounded, best-effort terminal history. Live PTY delivery never depends on saving it. */
export class LogStore {
  private readonly fds = new Map<string, number>();
  private readonly pending = new Map<string, Buffer>();
  private readonly sizes = new Map<string, number>();
  private pendingBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private retryAt = 0;
  private retryMs = 1000;
  private failed = false;

  constructor(
    private readonly logsDir: string,
    private readonly replayBytes: number,
    private readonly maxBytes = 10 * 1024 * 1024,
    private readonly onHealth?: (degraded: boolean) => void,
  ) {}

  /** Exposed for diagnostics: includes every unsaved terminal, even after PTY exit. */
  bufferedBytes(): number {
    return this.pendingBytes;
  }

  append(sessionId: string, term: string, data: string): void {
    const key = `${sessionId}/${term}`;
    // Flush healthy buffers before discarding history at the memory bound.
    if (
      !this.failed &&
      (this.pending.get(key)?.length ?? 0) + Buffer.byteLength(data) > PER_TERM_BYTES
    )
      this.flushAll();
    const incoming = Buffer.from(data);
    const previous = this.pending.get(key);
    const tail =
      incoming.length >= PER_TERM_BYTES
        ? Buffer.from(incoming.subarray(-PER_TERM_BYTES))
        : Buffer.concat([
            previous?.subarray(-(PER_TERM_BYTES - incoming.length)) ?? Buffer.alloc(0),
            incoming,
          ]);
    this.setPending(key, tail);
    while (this.pendingBytes > TOTAL_PENDING_BYTES) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.setPending(oldest, null);
    }
    this.schedule();
  }

  close(sessionId: string, term: string): void {
    const key = `${sessionId}/${term}`;
    this.flushAll();
    this.closeFd(key);
    // A failed flush retains only bounded history and retries without retaining a PTY.
  }

  closeAll(): void {
    this.flushAll();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const key of this.fds.keys()) this.closeFd(key);
  }

  readTail(sessionId: string, term: string): string {
    const key = `${sessionId}/${term}`;
    this.flushAll();
    const pending = this.pending.get(key) ?? Buffer.alloc(0);
    const file = this.file(sessionId, term);
    if (!existsSync(file)) return pending.subarray(-this.replayBytes).toString('utf8');
    const size = statSync(file).size;
    const length = Math.min(size, Math.max(0, this.replayBytes - pending.length));
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, size - length);
      return Buffer.concat([buf.subarray(0, read), pending])
        .subarray(-this.replayBytes)
        .toString('utf8');
    } finally {
      closeSync(fd);
    }
  }

  listTerms(sessionId: string): string[] {
    const dir = join(this.logsDir, sessionId);
    const disk = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.log'))
          .map((f) => f.slice(0, -4))
      : [];
    const memory = [...this.pending.keys()]
      .filter((key) => key.startsWith(`${sessionId}/`))
      .map((key) => this.split(key)[1]);
    return [...new Set([...disk, ...memory])];
  }

  historyFile(sessionId: string): string {
    const dir = join(this.logsDir, sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, 'shell-history');
  }

  flushAll(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (Date.now() < this.retryAt) {
      this.schedule();
      return;
    }
    for (const key of this.pending.keys()) {
      try {
        this.flush(key);
      } catch (error) {
        this.closeFd(key);
        if (!this.failed) {
          this.failed = true;
          this.onHealth?.(true);
          console.warn(
            'Terminal history is temporarily not being saved:',
            isStorageFull(error) ? 'storage full' : error,
          );
        }
        this.retryAt = Date.now() + this.retryMs;
        this.retryMs = Math.min(30_000, this.retryMs * 2);
        this.schedule();
        return;
      }
    }
    if (this.failed) {
      this.failed = false;
      this.onHealth?.(false);
    }
    this.retryAt = 0;
    this.retryMs = 1000;
  }

  private schedule(): void {
    if (this.flushTimer || this.pending.size === 0) return;
    this.flushTimer = setTimeout(
      () => this.flushAll(),
      Math.max(FLUSH_MS, this.retryAt - Date.now()),
    );
    this.flushTimer.unref?.();
  }

  private setPending(key: string, data: Buffer | null): void {
    this.pendingBytes -= this.pending.get(key)?.length ?? 0;
    this.pending.delete(key);
    if (data !== null) {
      this.pending.set(key, data);
      this.pendingBytes += data.length;
    }
  }

  private flush(key: string): void {
    const data = this.pending.get(key);
    if (!data) return;
    const [sessionId, term] = this.split(key);
    let fd = this.fds.get(key);
    if (fd === undefined) {
      mkdirSync(join(this.logsDir, sessionId), { recursive: true, mode: 0o700 });
      fd = openSync(this.file(sessionId, term), 'a', 0o600);
      this.fds.set(key, fd);
      this.sizes.set(key, statSync(this.file(sessionId, term)).size);
    }
    // Recover a failed rotation before writing more, including an empty retry marker.
    if ((this.sizes.get(key) ?? 0) > this.maxBytes) {
      this.rotate(key, sessionId, term);
      fd = this.fds.get(key)!;
    }
    let written = 0;
    try {
      while (written < data.length) {
        const count = writeSync(fd, data, written, data.length - written);
        if (count === 0) throw new Error('Terminal log write made no progress');
        written += count;
        this.sizes.set(key, (this.sizes.get(key) ?? 0) + count);
      }
    } finally {
      // Short writes followed by ENOSPC must not duplicate their successful prefix.
      this.setPending(key, Buffer.from(data.subarray(written)));
    }
    if ((this.sizes.get(key) ?? 0) > this.maxBytes) this.rotate(key, sessionId, term);
    this.setPending(key, null);
  }

  private rotate(key: string, sessionId: string, term: string): void {
    const file = this.file(sessionId, term);
    const size = this.sizes.get(key) ?? 0;
    const keep = Math.min(size, Math.max(this.replayBytes, Math.floor(this.maxBytes / 2)));
    const buf = Buffer.alloc(keep);
    const readFd = openSync(file, 'r');
    let read: number;
    try {
      read = readSync(readFd, buf, 0, keep, size - keep);
    } finally {
      closeSync(readFd);
    }
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, buf.subarray(0, read), { mode: 0o600 });
      this.closeFd(key);
      renameSync(tmp, file);
      this.fds.set(key, openSync(file, 'a', 0o600));
      this.sizes.set(key, read);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* Absent after rename, or disk unavailable. */
      }
    }
  }

  private closeFd(key: string): void {
    const fd = this.fds.get(key);
    this.fds.delete(key);
    this.sizes.delete(key);
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Log cleanup must never stop PTY cleanup. */
      }
    }
  }

  private split(key: string): [string, string] {
    const slash = key.indexOf('/');
    return [key.slice(0, slash), key.slice(slash + 1)];
  }

  private file(sessionId: string, term: string): string {
    return join(this.logsDir, sessionId, `${term}.log`);
  }
}
