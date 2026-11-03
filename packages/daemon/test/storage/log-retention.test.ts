import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogStore } from '../../src/logs/log-store.js';
import { compactTerminalLogs, LogRetention } from '../../src/logs/retention.js';
import { PtyManager } from '../../src/pty/pty-manager.js';
import { TerminalScreenStateStore } from '../../src/pty/terminal-screen-state.js';

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return { ...real, open: vi.fn(real.open) };
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Math.floor(Date.now() / 1000) * 1000;

/** Windows creates file symlinks only under Developer Mode or elevation. */
const fileSymlinks = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-link-probe-'));
  try {
    symlinkSync(join(dir, 'missing'), join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
let home: string;
beforeEach(() => {
  vi.resetAllMocks();
  home = mkdtempSync(join(tmpdir(), 'puddle-retention-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});
function log(stream = 'archived', term = 'agent', age = 4, data = 'old output\r\n'.repeat(1000)) {
  const directory = join(home, stream);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${term}.log`);
  writeFileSync(file, data, { mode: 0o600 });
  utimesSync(file, new Date(NOW - age * DAY), new Date(NOW - age * DAY));
  return file;
}
const sweep = (isBusy = () => false, retentionDays = 3) =>
  compactTerminalLogs({ logsDir: home, retentionDays, replayBytes: 1024, isBusy, now: NOW });

describe('three-day bulk terminal log retention', () => {
  it('preserves exact replay, shell ids, shell history and snapshots', async () => {
    const file = log();
    log('archived', 'shell-4');
    const snapshot = join(home, 'archived/agent.terminal.json');
    const history = join(home, 'archived/shell-history');
    writeFileSync(snapshot, '{"version":1,"cols":80,"rows":24,"data":"saved screen"}');
    writeFileSync(history, 'shell commands\n');
    const logs = new LogStore(home, 1024);
    const before = logs.readTail('archived', 'agent');
    const result = await sweep();
    expect(result.compacted).toBe(2);
    expect(statSync(file).size).toBe(1024);
    expect(logs.readTail('archived', 'agent')).toBe(before);
    expect(logs.listTerms('archived').sort()).toEqual(['agent', 'shell-4']);
    expect(readFileSync(snapshot, 'utf8')).toContain('saved screen');
    expect(readFileSync(history, 'utf8')).toBe('shell commands\n');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600); // no mode bits on Windows
    expect((await sweep()).compacted).toBe(0);
    logs.closeAll();
  });
  it('reopens an archived canonical snapshot identically after cleanup', async () => {
    log();
    const screen = new TerminalScreenStateStore(home);
    screen.resize('archived', 'agent', 80, 24);
    screen.write('archived', 'agent', '\u001b[32mSaved output\u001b[0m\r\nPrompt> ');
    const before = await screen.snapshot('archived', 'agent');
    await screen.closeAll();
    await sweep();
    const restored = new TerminalScreenStateStore(home);
    try {
      expect(await restored.snapshot('archived', 'agent')).toBe(before);
    } finally {
      await restored.closeAll();
    }
  });
  it('reopens a legacy terminal identically without a saved snapshot', async () => {
    log();
    const logs = new LogStore(home, 1024);
    const before = new PtyManager(logs);
    const expected = await before.snapshot('archived', 'agent', 80, 24);
    await before.closeTerminalStates();
    await sweep();
    const after = new PtyManager(logs);
    try {
      expect(await after.snapshot('archived', 'agent', 80, 24)).toBe(expected);
    } finally {
      await after.closeTerminalStates();
      logs.closeAll();
    }
  });
  it('skips recent and live logs, diagnostics and small replay tails', async () => {
    const recent = log('recent', 'agent', 2);
    const live = log('live');
    const small = log('small', 'agent', 4, 'tiny');
    const diagnostic = join(home, 'puddled.out.log');
    writeFileSync(diagnostic, 'diagnostics');
    const sizes = [recent, live, small, diagnostic].map((file) => statSync(file).size);
    const result = await compactTerminalLogs({
      logsDir: home,
      retentionDays: 3,
      replayBytes: 1024,
      isBusy: (stream) => stream === 'live',
      now: NOW,
    });
    expect(result.compacted).toBe(0);
    expect([recent, live, small, diagnostic].map((file) => statSync(file).size)).toEqual(sizes);
  });
  it('compacts under the Windows rules (source closed before replacement) on any host', async () => {
    const file = log();
    const tail = readFileSync(file).subarray(-1024);
    const result = await compactTerminalLogs({
      logsDir: home,
      retentionDays: 3,
      replayBytes: 1024,
      isBusy: () => false,
      now: NOW,
      platform: 'win32',
    });
    expect(result).toMatchObject({ compacted: 1, failed: 0 });
    expect(readFileSync(file)).toEqual(tail);
  });
  it('honours disabled retention and the exact cutoff', async () => {
    log('old');
    const boundary = log('boundary', 'agent', 3);
    expect((await sweep(() => false, 0)).compacted).toBe(0);
    expect((await sweep()).compacted).toBe(1);
    expect(statSync(boundary).size).toBeGreaterThan(1024);
  });
  it('skips a terminal that opens while its tail is being copied', async () => {
    const file = log();
    const before = readFileSync(file);
    let checks = 0;
    expect((await sweep(() => ++checks >= 3)).compacted).toBe(0);
    expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(join(home, 'archived'))).toEqual(['agent.log']);
  });
  it('detects a concurrent append before replacement', async () => {
    const file = log();
    const before = readFileSync(file, 'utf8');
    let checks = 0;
    expect(
      (
        await sweep(() => {
          if (++checks === 3) appendFileSync(file, 'new');
          return false;
        })
      ).compacted,
    ).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before + 'new');
    expect(readdirSync(join(home, 'archived'))).toEqual(['agent.log']);
  });
  it('keeps the original recording when the disk fills during compaction', async () => {
    const file = log();
    const before = readFileSync(file);
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fsPromises.open).mockImplementation(async (...args) => {
      const handle = await real.open(...args);
      if (String(args[0]).includes('.retention-'))
        vi.spyOn(handle, 'write').mockRejectedValueOnce(
          Object.assign(new Error('No space left on device'), { code: 'ENOSPC' }),
        );
      return handle;
    });
    expect(await sweep()).toMatchObject({ compacted: 0, failed: 1, reclaimedBytes: 0 });
    expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(join(home, 'archived'))).toEqual(['agent.log']);
  });
  it('coalesces maintenance and keeps configuration failures asynchronous', async () => {
    const retention = new LogRetention(() => {
      throw new Error('Cannot read configuration');
    });
    const first = retention.sweep();
    expect(retention.sweep()).toBe(first);
    await expect(first).rejects.toThrow('Cannot read configuration');
    await retention.dispose();
  });
  it('does not follow symlinked files or directories', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'puddle-retention-outside-'));
    try {
      const target = join(outside, 'agent.log');
      writeFileSync(target, 'outside'.repeat(2000));
      utimesSync(target, new Date(NOW - 4 * DAY), new Date(NOW - 4 * DAY));
      // Windows: a junction for the directory (no privilege needed); the file
      // link only where this account may create file symlinks.
      if (process.platform === 'win32')
        symlinkSync(outside, join(home, 'linked-directory'), 'junction');
      else symlinkSync(outside, join(home, 'linked-directory'));
      mkdirSync(join(home, 'real'));
      if (fileSymlinks) symlinkSync(target, join(home, 'real/agent.log'));
      expect((await sweep()).compacted).toBe(0);
      expect(statSync(target).size).toBe(14000);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
