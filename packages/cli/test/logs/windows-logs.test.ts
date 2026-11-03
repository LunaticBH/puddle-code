import { appendFileSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { showLogs } from '../../src/lib/logs.js';
import { LocalTransport } from '../../src/lib/transport/local.js';
import { lastLines, showWindowsLogs } from '../../src/lib/windows-logs.js';

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-windows-logs-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

describe('puddle logs on this Windows machine, without tail or journald', () => {
  it('prints the last 256 KiB of a session log and rejects an unknown session', async () => {
    const dir = home();
    mkdirSync(join(dir, 'logs', 'abc'));
    writeFileSync(join(dir, 'logs', 'abc', 'agent.log'), 'x'.repeat(300_000) + 'END');
    let out = '';
    await showWindowsLogs(dir, { session: 'abc', write: (chunk) => (out += chunk) });
    expect(out).toHaveLength(262_144);
    expect(out.endsWith('END')).toBe(true);
    await expect(showWindowsLogs(dir, { session: 'nope', write: () => {} })).rejects.toMatchObject({
      code: 'unknown_session',
    });
  });

  it('prints the last 200 lines of each daemon log under a header', async () => {
    const dir = home();
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n') + '\n';
    writeFileSync(join(dir, 'logs', 'puddled.out.log'), lines);
    writeFileSync(join(dir, 'logs', 'puddled.err.log'), 'oops\n');
    let out = '';
    await showWindowsLogs(dir, { write: (chunk) => (out += chunk) });
    expect(out).toContain(`==> ${join(dir, 'logs', 'puddled.out.log')} <==\nline 50\n`);
    expect(out).not.toContain('line 49\n');
    expect(out).toContain(`\n==> ${join(dir, 'logs', 'puddled.err.log')} <==\noops\n`);
  });

  it('says where daemon logs would be when there are none', async () => {
    const dir = home();
    let out = '';
    await showWindowsLogs(dir, { write: (chunk) => (out += chunk) });
    expect(out).toContain('no daemon logs found');
  });

  it('follows appends, and rereads a log that was rotated', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const dir = home();
      const file = join(dir, 'logs', 'puddled.out.log');
      writeFileSync(file, 'old\n');
      const abort = new AbortController();
      let out = '';
      const following = showWindowsLogs(dir, {
        follow: true,
        signal: abort.signal,
        write: (chunk) => (out += chunk),
      });
      appendFileSync(file, 'new\n');
      await vi.advanceTimersByTimeAsync(600);
      expect(out.endsWith('old\nnew\n')).toBe(true);
      writeFileSync(file, 'fresh\n'); // Shorter than before: rotated at the next spawn.
      await vi.advanceTimersByTimeAsync(600);
      expect(out.endsWith('new\nfresh\n')).toBe(true);
      abort.abort();
      await vi.advanceTimersByTimeAsync(600);
      await following;
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads lines from the end of a large log, keeping a missing final newline missing', () => {
    const dir = home();
    const file = join(dir, 'big.log');
    writeFileSync(file, Array.from({ length: 50_000 }, (_, i) => `entry ${i}`).join('\n'));
    expect(lastLines(file, statSync(file).size, 2)).toBe('entry 49998\nentry 49999');
    expect(lastLines(file, statSync(file).size, 100_000).startsWith('entry 0\n')).toBe(true);
  });

  it('is what showLogs uses for this machine on Windows', async () => {
    const dir = home();
    const saved = process.env.PUDDLE_HOME;
    process.env.PUDDLE_HOME = dir;
    try {
      let out = '';
      await showLogs(new LocalTransport({ platform: 'win32' }), {
        write: (chunk) => (out += chunk),
      });
      expect(out).toContain('no daemon logs found');
    } finally {
      if (saved === undefined) delete process.env.PUDDLE_HOME;
      else process.env.PUDDLE_HOME = saved;
    }
  });
});
