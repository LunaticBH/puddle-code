import { renameSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Atomic replacement that tolerates Windows sharing violations. Replacing a
 * file fails with EPERM, EACCES or EBUSY while another process (an antivirus
 * scanner, the search indexer, a reader without FILE_SHARE_DELETE) has the
 * target open, so Windows retries with a short backoff for about a second in
 * total. POSIX performs exactly one plain rename.
 */
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);
const BACKOFF_MS = [10, 20, 40, 80, 120, 160, 200, 200, 200];

export function renameWithRetrySync(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') return renameSync(from, to);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const wait = retryDelay(err, attempt);
      if (wait === null) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

export async function renameWithRetry(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'win32') return rename(from, to);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const wait = retryDelay(err, attempt);
      if (wait === null) throw err;
      await delay(wait);
    }
  }
}

function retryDelay(err: unknown, attempt: number): number | null {
  if (!RETRYABLE.has((err as NodeJS.ErrnoException).code ?? '')) return null;
  return BACKOFF_MS[attempt] ?? null;
}
