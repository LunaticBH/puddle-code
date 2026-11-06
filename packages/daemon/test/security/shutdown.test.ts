import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { controlResponseSchema } from '@puddle/shared';
import { ipcPath, jsonLines } from '@puddle/shared/node';
import {
  endDaemonWork,
  listenWithFallback,
  startDaemon,
  stopRemainingConptys,
} from '../../src/daemon.js';

function request(path: string, message: object) {
  return new Promise<ReturnType<typeof controlResponseSchema.parse>>((resolve, reject) => {
    const socket = connect(path);
    socket.once('error', reject);
    jsonLines(
      socket,
      (value) => {
        resolve(controlResponseSchema.parse(value));
        socket.destroy();
      },
      () => reject(new Error('Invalid response')),
    );
    socket.write(JSON.stringify(message) + '\n');
  });
}

function reachable(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

describe('host-control shutdown (protocol 25.7)', () => {
  for (const platform of ['linux', 'win32'] as const) {
    it(`stops the daemon and only then reports it stopped (${platform} order)`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'puddle-shutdown-'));
      let resolveStopped!: () => void;
      const stopped = new Promise<void>((resolve) => (resolveStopped = resolve));
      const daemon = await startDaemon({
        home,
        port: 0,
        adapters: [],
        version: 'shutdown-test',
        platform,
        onShutdown: () => resolveStopped(),
      });
      const path = ipcPath(home, 'host');
      expect(existsSync(join(home, 'runtime.json'))).toBe(true);
      expect(await request(path, { t: 'shutdown' })).toEqual({ t: 'shutting_down' });
      await stopped;
      // Everything is closed by the time the supervisor is told: no live
      // record, and the control endpoint (Windows' single-instance lock) gone.
      expect(existsSync(join(home, 'runtime.json'))).toBe(false);
      expect(await reachable(path)).toBe(false);
      // A later explicit stop is the same, already finished, stop.
      await daemon.stop();
    });
  }

  it('refuses shutdown when the embedder supplies no handler', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-shutdown-'));
    const daemon = await startDaemon({ home, port: 0, adapters: [], version: 'shutdown-test' });
    try {
      expect(await request(ipcPath(home, 'host'), { t: 'shutdown' })).toEqual({
        t: 'error',
        code: 'invalid_control',
      });
    } finally {
      await daemon.stop();
    }
  });
});

describe('stopping the ConPTYs that outlast their consoles’ closing', () => {
  it('forces each one’s tree, then waits until every one has reported its exit', async () => {
    let live = 2;
    const signals: Array<string | undefined> = [];
    const ptys = {
      killAll: (_stream?: string, signal?: string) => {
        signals.push(signal);
        // Each reports its exit only once its tree is stopped: later.
        setTimeout(() => (live = 1), 30);
        setTimeout(() => (live = 0), 60);
      },
      liveCount: () => live,
    };
    const started = Date.now();
    await stopRemainingConptys(ptys);
    expect(signals).toEqual(['SIGKILL']);
    expect(live).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('gives up waiting at its bound', async () => {
    const ptys = { killAll: () => {}, liveCount: () => 1 };
    const started = Date.now();
    await stopRemainingConptys(ptys, 100);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('ending the daemon’s work as it stops', () => {
  /** PTYs that exit as soon as they are killed, and a record of when things happened. */
  function work(executionsMs: number | null) {
    const events: string[] = [];
    let live = 1;
    let finish: (() => void) | undefined;
    return {
      events,
      finish: () => finish?.(),
      work: {
        executions: () =>
          new Promise<void>((resolve) => {
            finish = () => {
              events.push('executions done');
              resolve();
            };
            if (executionsMs !== null) setTimeout(() => finish!(), executionsMs);
          }),
        beginShutdown: () => events.push('shutdown begun'),
        ptys: {
          killAll: () => {
            events.push('ptys killed');
            live = 0;
          },
          liveCount: () => live,
          settled: async () => {
            events.push('ptys settled');
          },
        },
        lifecyclesDisposed: async () => {
          events.push('lifecycles disposed');
        },
      },
    };
  }

  it('ends the PTYs on Windows while compile commands and kernels stop, then waits for those', async () => {
    const { events, work: daemon } = work(300);
    const started = Date.now();
    await endDaemonWork(daemon, 'win32');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(events).toEqual([
      'shutdown begun',
      'ptys killed',
      'ptys settled',
      'lifecycles disposed',
      'executions done',
    ]);
  });

  it('waits for compile commands and kernels on Windows within a bound from when they began', async () => {
    const { events, finish, work: daemon } = work(null);
    const started = Date.now();
    await endDaemonWork(daemon, 'win32', { executionsMs: 200, settleMs: 0, lifecycleMs: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(events).not.toContain('executions done');
    finish();
  });

  it('keeps POSIX on disposing of compile commands and kernels before the PTYs', async () => {
    const { events, work: daemon } = work(100);
    await endDaemonWork(daemon, 'linux');
    expect(events).toEqual(['executions done', 'shutdown begun', 'ptys killed']);
  });
});

describe('the daemon port bind', () => {
  /** A server whose first bind fails with `code`, then binds port 4242. */
  function fakeServer(code: string) {
    let attempts = 0;
    const server = Object.assign(new EventEmitter(), {
      listen(port: number) {
        attempts++;
        queueMicrotask(() =>
          attempts === 1 && port !== 0
            ? server.emit('error', Object.assign(new Error(code), { code }))
            : server.emit('listening'),
        );
      },
      address: () => ({ port: 4242 }),
    });
    return server;
  }
  type Server = Parameters<typeof listenWithFallback>[0];

  it('falls back off a port Windows reserved (EACCES there is contention)', async () => {
    const server = fakeServer('EACCES') as unknown as Server;
    await expect(listenWithFallback(server, 7434, '127.0.0.1', 'win32')).resolves.toBe(4242);
  });

  it('keeps EACCES fatal on POSIX, where it means a privileged port', async () => {
    const server = fakeServer('EACCES') as unknown as Server;
    await expect(listenWithFallback(server, 80, '127.0.0.1', 'linux')).rejects.toMatchObject({
      code: 'EACCES',
    });
  });
});
