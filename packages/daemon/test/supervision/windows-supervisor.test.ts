import { mkdtempSync } from 'node:fs';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcPath, ipcProof, listenPrivate } from '@puddle/shared/node';
import {
  DAEMON_ALREADY_ACTIVE_EXIT,
  supervisorRequest,
  type ControlPipeState,
} from '@puddle/shared/node/platform';
import {
  WindowsSupervisor,
  type SupervisedChild,
  type SupervisorDeps,
} from '../../src/supervision/windows-supervisor.js';

/**
 * The Windows supervisor's state machine with stand-in children and short
 * delays; its control pipe is a real one (a Unix socket on POSIX), so this
 * runs on any OS and never starts a process.
 */
interface FakeChild extends SupervisedChild {
  exit(code: number | null): void;
  stop: Mock<() => void>;
  kill: Mock<() => Promise<void>>;
}

function fakeChild(pid: number, onStop?: (child: FakeChild) => void): FakeChild {
  let exit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => (exit = resolve));
  const child: FakeChild = {
    pid,
    exited,
    exit: (code) => exit(code),
    stop: vi.fn<() => void>(() => onStop?.(child)),
    kill: vi.fn<() => Promise<void>>(async () => exit(null)),
  };
  return child;
}

const supervisors: Array<{ supervisor: WindowsSupervisor; done: Promise<number> }> = [];
afterEach(async () => {
  for (const { supervisor, done } of supervisors.splice(0)) {
    void supervisor.shutdown('test over');
    await done;
  }
});

const until = async (check: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function harness(
  options: {
    connector?: boolean;
    manager?: 'absent' | 'proven' | 'foreign' | 'unknown';
    /** The daemon ignores `shutdown`. */
    stubborn?: boolean;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-supervisor-'));
  const log: string[] = [];
  const daemons: FakeChild[] = [];
  const connectors: FakeChild[] = [];
  const pids: Array<number | null> = [];
  const state = {
    wanted: options.connector ?? false,
    hostPipe: 'absent' as ControlPipeState,
    manager: options.manager ?? 'absent',
  };
  let next = 100;
  const shutdowns = vi.fn(async () => {
    const daemon = daemons.at(-1);
    if (!options.stubborn) setTimeout(() => daemon?.exit(0), 5);
    return 'stopping' as const;
  });
  const deps: SupervisorDeps = {
    pid: 4242,
    log: (line) => log.push(line),
    listen: (onConnection) => listenPrivate(ipcPath(home, 'supervisor'), onConnection),
    holder: async () => (await supervisorRequest(home, 'status')).kind,
    spawnDaemon: () => {
      const child = fakeChild(next++);
      daemons.push(child);
      return child;
    },
    spawnConnector: () => {
      const child = fakeChild(next++, (self) => setTimeout(() => self.exit(0), 5));
      connectors.push(child);
      return child;
    },
    connectorWanted: () => state.wanted,
    hostPipe: async () => state.hostPipe,
    requestDaemonShutdown: shutdowns,
    connectorManager: async () => state.manager,
    writePid: (pid) => pids.push(pid),
    proof: (challenge) => ipcProof(home, 'supervisor', challenge),
    now: () => Date.now(),
    timing: {
      firstBackoffMs: 10,
      maxBackoffMs: 40,
      daemonStopGraceMs: 200,
      connectorStopGraceMs: 200,
      connectorRecheckMs: 50,
    },
  };
  const start = () => {
    const supervisor = new WindowsSupervisor(deps);
    const done = supervisor.run();
    supervisors.push({ supervisor, done });
    return { supervisor, done };
  };
  return { home, log, daemons, connectors, pids, state, shutdowns, deps, start };
}

describe('the Windows supervisor', () => {
  it('runs the daemon, records its pid and answers with its proof', async () => {
    const h = harness();
    h.start();
    await until(() => h.daemons.length === 1);
    expect(h.pids).toEqual([100]);
    const answer = await supervisorRequest(h.home, 'status');
    expect(answer).toEqual({
      kind: 'answered',
      state: {
        t: 'supervisor',
        proof: expect.stringMatching(/^[0-9a-f]{64}$/),
        pid: 4242,
        daemon: 100,
        connector: null,
        stopping: false,
      },
    });
  });

  it('exits 0 with the daemon when it was asked to stop, stopping the connector too', async () => {
    const h = harness({ connector: true });
    const { done } = h.start();
    await until(() => h.connectors.length === 1);
    h.daemons[0]!.exit(0);
    expect(await done).toBe(0);
    expect(h.connectors[0]!.stop).toHaveBeenCalledOnce();
    expect(h.pids.at(-1)).toBeNull();
    expect(h.daemons).toHaveLength(1);
  });

  it('never restarts a daemon that found its home already served', async () => {
    const h = harness();
    const { done } = h.start();
    await until(() => h.daemons.length === 1);
    h.daemons[0]!.exit(DAEMON_ALREADY_ACTIVE_EXIT);
    expect(await done).toBe(0);
    expect(h.daemons).toHaveLength(1);
    expect(h.log.join('\n')).toMatch(/another puddled serves this home/);
  });

  it('steps aside, connector included, for a daemon that another launcher started', async () => {
    const h = harness({ connector: true });
    const { done } = h.start();
    await until(() => h.connectors.length === 1);
    h.daemons[0]!.exit(DAEMON_ALREADY_ACTIVE_EXIT);
    // Lingering without a daemon, it would answer a launch as the one starting it.
    expect(await done).toBe(0);
    expect(h.connectors[0]!.stop).toHaveBeenCalledOnce();
    expect(h.daemons).toHaveLength(1);
    expect(h.pids.at(-1)).toBeNull();
    expect(await supervisorRequest(h.home, 'status')).toEqual({ kind: 'absent' });
  });

  it('restarts a crashed daemon with doubling backoff, then gives up', async () => {
    const h = harness();
    const { done } = h.start();
    for (let crash = 1; crash <= 10; crash++) {
      await until(() => h.daemons.length === crash);
      h.daemons[crash - 1]!.exit(1);
    }
    expect(await done).toBe(1);
    expect(h.daemons).toHaveLength(10);
    const delays = h.log
      .filter((line) => line.startsWith('restarting puddled in'))
      .map((line) => /in ([\d.]+) s/.exec(line)![1]);
    expect(delays).toEqual([
      '0.01',
      '0.02',
      '0.04',
      '0.04',
      '0.04',
      '0.04',
      '0.04',
      '0.04',
      '0.04',
    ]);
    expect(h.log.join('\n')).toMatch(/failed 10 times in ten minutes — giving up/);
  });

  it('never starts a daemon beside one that took the home over while it waited', async () => {
    const h = harness();
    const { done } = h.start();
    await until(() => h.daemons.length === 1);
    h.state.hostPipe = 'daemon';
    h.daemons[0]!.exit(1);
    expect(await done).toBe(0);
    expect(h.daemons).toHaveLength(1);
    expect(h.log.join('\n')).toMatch(/another puddled took over this home/);

    const supervised = harness({ connector: true });
    const second = supervised.start();
    await until(() => supervised.connectors.length === 1);
    supervised.state.hostPipe = 'unknown';
    supervised.daemons[0]!.exit(1);
    expect(await second.done).toBe(0);
    expect(supervised.connectors[0]!.stop).toHaveBeenCalledOnce();
  });

  it('defers to a supervisor that already runs, and refuses a squatter on its pipe', async () => {
    const h = harness();
    h.start();
    await until(() => h.daemons.length === 1);
    expect(await new WindowsSupervisor(h.deps).run()).toBe(0);
    expect(h.daemons).toHaveLength(1);

    const squatted = harness();
    const sockets = new Set<Socket>();
    const squatter: Server = await listenPrivate(ipcPath(squatted.home, 'supervisor'), (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.end(JSON.stringify({ t: 'supervisor' }) + '\n');
    });
    try {
      expect(await new WindowsSupervisor(squatted.deps).run()).toBe(1);
      expect(squatted.daemons).toHaveLength(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it('shuts the daemon and connector down on request, answering first', async () => {
    const h = harness({ connector: true });
    const { done } = h.start();
    await until(() => h.connectors.length === 1);
    const answer = await supervisorRequest(h.home, 'shutdown');
    expect(answer).toMatchObject({ kind: 'answered', state: { stopping: true } });
    expect(await done).toBe(0);
    expect(h.shutdowns).toHaveBeenCalled();
    expect(h.connectors[0]!.stop).toHaveBeenCalledOnce();
    expect(h.daemons[0]!.kill).not.toHaveBeenCalled();
  });

  it('terminates a daemon that does not stop within its grace', async () => {
    const h = harness({ stubborn: true });
    const { supervisor, done } = h.start();
    await until(() => h.daemons.length === 1);
    void supervisor.shutdown('test');
    expect(await done).toBe(0);
    expect(h.daemons[0]!.kill).toHaveBeenCalledOnce();
  });
});

describe('the supervised connector', () => {
  it('starts only while remote access is supervised, and restarts it after a crash', async () => {
    const h = harness();
    h.start();
    await until(() => h.daemons.length === 1);
    expect(h.connectors).toHaveLength(0);
    h.state.wanted = true;
    await supervisorRequest(h.home, 'reconcile');
    await until(() => h.connectors.length === 1);
    h.connectors[0]!.exit(3);
    await until(() => h.connectors.length === 2);
    expect(h.log.join('\n')).toMatch(/restarting the connector in 0\.01 s/);
    // A clean exit is not restarted, as with Restart=on-failure.
    h.connectors[1]!.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.connectors).toHaveLength(2);
  });

  it('stops the connector when its supervision ends, without stopping the daemon', async () => {
    const h = harness({ connector: true });
    h.start();
    await until(() => h.connectors.length === 1);
    h.state.wanted = false;
    await supervisorRequest(h.home, 'reconcile');
    await until(() => h.connectors[0]!.stop.mock.calls.length === 1);
    expect(h.shutdowns).not.toHaveBeenCalled();
    expect((await supervisorRequest(h.home, 'status')).kind).toBe('answered');
  });

  it('replaces a running connector after an upgrade', async () => {
    const h = harness({ connector: true });
    h.start();
    await until(() => h.connectors.length === 1);
    const answer = await supervisorRequest(h.home, 'restart_connector');
    expect(h.connectors[0]!.stop).toHaveBeenCalledOnce();
    await until(() => h.connectors.length === 2);
    expect(answer).toMatchObject({ kind: 'answered' });
  });

  it('never starts a second connector beside `puddle remote run`', async () => {
    const h = harness({ connector: true, manager: 'proven' });
    h.start();
    await until(() => h.log.some((line) => line.includes('another connector serves this home')));
    expect(h.connectors).toHaveLength(0);
    h.state.manager = 'absent';
    await until(() => h.connectors.length === 1);
  });
});
