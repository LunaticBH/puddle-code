import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { LogsOptions } from './logs.js';
import { sleep } from './transport/net.js';
import { CliError } from './types.js';

/**
 * `puddle logs` on this Windows machine, with no `tail` or journald: the
 * same 256 KiB session tail and 200-line daemon tail, read with positioned
 * reads, and `--follow` by polling sizes (fs.watch is unreliable for files
 * another process appends to). A shrinking file was rotated or replaced and
 * is read again from its start.
 */

const SESSION_TAIL_BYTES = 262_144;
const DAEMON_TAIL_LINES = 200;
const FOLLOW_INTERVAL_MS = 500;

export async function showWindowsLogs(home: string, opts: LogsOptions): Promise<void> {
  if (opts.session !== undefined) {
    const file = join(home, 'logs', opts.session, `${opts.term ?? 'agent'}.log`);
    if (!existsSync(file)) {
      throw new CliError(
        'unknown_session',
        `no log at ${file}`,
        'list sessions with: puddle status — the id is the log directory name',
      );
    }
    const size = statSync(file).size;
    const start = Math.max(0, size - SESSION_TAIL_BYTES);
    opts.write(readRange(file, start, size).toString('utf8'));
    if (opts.follow) await follow([{ file, offset: size }], opts);
    return;
  }

  const files = ['puddled.out.log', 'puddled.err.log']
    .map((name) => join(home, 'logs', name))
    .filter((file) => existsSync(file));
  if (files.length === 0) {
    opts.write(`no daemon logs found — the daemon writes them to ${join(home, 'logs')}\n`);
    return;
  }
  const tracked = files.map((file, index) => {
    const size = statSync(file).size;
    // Like tail with several files: a header names each one.
    const separator = index === 0 ? '' : '\n';
    opts.write(`${separator}==> ${file} <==\n${lastLines(file, size, DAEMON_TAIL_LINES)}`);
    return { file, offset: size };
  });
  if (opts.follow) await follow(tracked, opts);
}

function readRange(file: string, start: number, end: number): Buffer {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  if (buffer.length === 0) return buffer;
  const fd = openSync(file, 'r');
  try {
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** The last `count` lines, reading backwards in chunks so a large log is never loaded whole. */
export function lastLines(file: string, size: number, count: number): string {
  const chunk = 64 * 1024;
  let start = size;
  let text = '';
  while (start > 0) {
    const from = Math.max(0, start - chunk);
    text = readRange(file, from, start).toString('utf8') + text;
    start = from;
    // One more newline than lines: the last line's terminator.
    if ((text.match(/\n/g)?.length ?? 0) > count) break;
  }
  const lines = text.split('\n');
  const trailing = lines.at(-1) === '' ? lines.pop() : undefined;
  return lines.slice(-count).join('\n') + (trailing === '' ? '\n' : '');
}

async function follow(
  files: Array<{ file: string; offset: number }>,
  opts: LogsOptions,
): Promise<void> {
  // Appends may end mid-character; each file keeps its own decoder.
  const tracked = files.map((entry) => ({ ...entry, decoder: new StringDecoder('utf8') }));
  let last = tracked.at(-1)!.file;
  while (!opts.signal?.aborted) {
    await sleep(FOLLOW_INTERVAL_MS);
    for (const entry of tracked) {
      let size: number;
      try {
        size = statSync(entry.file).size;
      } catch {
        continue; // Rotated away for a moment.
      }
      if (size < entry.offset) entry.offset = 0;
      if (size === entry.offset) continue;
      const data = readRange(entry.file, entry.offset, size);
      entry.offset += data.length;
      if (tracked.length > 1 && last !== entry.file) opts.write(`\n==> ${entry.file} <==\n`);
      last = entry.file;
      opts.write(entry.decoder.write(data));
    }
  }
}
