import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogStore } from '../src/logs/log-store.js';

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    openSync: vi.fn(real.openSync),
    writeSync: vi.fn(real.writeSync),
    writeFileSync: vi.fn(real.writeFileSync),
  };
});
const full = () => Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
let home: string;
let logs: LogStore;
let health: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  home = fs.mkdtempSync(join(tmpdir(), 'puddle-log-full-'));
  health = vi.fn();
  logs = new LogStore(home, 32, 1024 * 1024, health);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  logs.closeAll();
  vi.useRealTimers();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('terminal history under disk exhaustion', () => {
  it.each(['openSync', 'writeSync'] as const)(
    'survives %s failures, streams a memory tail and recovers after exit',
    (method) => {
      vi.mocked(fs[method]).mockImplementationOnce(() => {
        throw full();
      });
      logs.append('session', 'agent', 'unsaved output');
      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
      expect(health).toHaveBeenCalledWith(true);
      expect(logs.readTail('session', 'agent')).toBe('unsaved output');
      expect(() => logs.close('session', 'agent')).not.toThrow();
      vi.advanceTimersByTime(1000);
      expect(fs.readFileSync(join(home, 'session/agent.log'), 'utf8')).toBe('unsaved output');
      expect(logs.bufferedBytes()).toBe(0);
      expect(health).toHaveBeenLastCalledWith(false);
    },
  );
  it('recovers a failed rotation without duplicating output or leaving a temporary file', () => {
    logs.closeAll();
    logs = new LogStore(home, 8, 64, health);
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw full();
    });
    logs.append('session', 'agent', 'x'.repeat(100) + 'END');
    logs.flushAll();
    expect(health).toHaveBeenCalledWith(true);
    expect(fs.readdirSync(join(home, 'session'))).toEqual(['agent.log']);
    vi.advanceTimersByTime(1000);
    expect(fs.readFileSync(join(home, 'session/agent.log'), 'utf8')).toBe('x'.repeat(29) + 'END');
    logs.append('session', 'agent', '+next');
    logs.flushAll();
    expect(logs.readTail('session', 'agent')).toBe('END+next');
    expect(health).toHaveBeenLastCalledWith(false);
  });
  it('does not duplicate a successful short write before ENOSPC', async () => {
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.writeSync).mockImplementationOnce((fd, buffer) =>
      real.writeSync(fd, buffer as Buffer, 0, 3),
    );
    vi.mocked(fs.writeSync).mockImplementationOnce(() => {
      throw full();
    });
    logs.append('session', 'agent', 'abcdefgh');
    logs.flushAll();
    expect(logs.readTail('session', 'agent')).toBe('abcdefgh');
    vi.advanceTimersByTime(1000);
    expect(fs.readFileSync(join(home, 'session/agent.log'), 'utf8')).toBe('abcdefgh');
  });
  it('caps all retained history and backs off instead of retrying on every append', () => {
    vi.mocked(fs.writeSync).mockImplementation(() => {
      throw full();
    });
    logs.append('session', 'agent', 'first');
    logs.flushAll();
    const calls = vi.mocked(fs.writeSync).mock.calls.length;
    for (let i = 0; i < 80; i++) logs.append(`session-${i}`, 'agent', 'x'.repeat(512 * 1024));
    expect(logs.bufferedBytes()).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(vi.mocked(fs.writeSync)).toHaveBeenCalledTimes(calls);
    expect(logs.readTail('session-79', 'agent')).toBe('x'.repeat(32));
  });
  it('preserves a large healthy append without applying the outage history cap', () => {
    const data = 'a'.repeat(600 * 1024);
    logs.append('session', 'agent', data);
    logs.flushAll();
    expect(fs.readFileSync(join(home, 'session/agent.log'), 'utf8') === data).toBe(true);
  });
});
