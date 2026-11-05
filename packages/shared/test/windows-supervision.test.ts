import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ipcPath, ipcProof, listenPrivate } from '../src/node/security.js';
import {
  startWindowsSupervisor,
  superviseWindowsConnector,
} from '../src/node/windows-supervision.js';
import {
  connectorPipeSquatted,
  connectorPipeState,
  supervisorRequest,
} from '../src/node/windows-pipes.js';
import type { PowerShellRunner } from '../src/node/windows-tasks.js';

/**
 * The launcher side of Windows supervision with stand-in pipe servers and a
 * recorded PowerShell. ipcPath gives Unix sockets on POSIX, so this runs on
 * any OS; nothing registers a task or starts a process.
 */
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const freshHome = () => mkdtempSync(join(tmpdir(), 'puddle-supervision-'));

/** One JSON line in, `reply(request)` out, on the home's `scope` pipe. */
async function serve(
  home: string,
  scope: string,
  reply: (request: Record<string, string>) => object | null,
) {
  const server = await listenPrivate(ipcPath(home, scope), (socket: Socket) => {
    socket.on('error', () => {});
    socket.once('data', (data: Buffer) => {
      const answer = reply(JSON.parse(data.toString()) as Record<string, string>);
      if (answer) socket.end(JSON.stringify(answer) + '\n');
    });
  });
  servers.push(server);
  return server;
}

const requests: string[] = [];
const supervisor = (home: string, forged = false) =>
  serve(home, 'supervisor', (request) => {
    requests.push(request.t!);
    return {
      t: 'supervisor',
      proof: forged ? 'f'.repeat(64) : ipcProof(home, 'supervisor', request.challenge!),
      pid: 4242,
      daemon: 4243,
      connector: null,
      stopping: false,
    };
  });

function powershell(reply: (env: Readonly<Record<string, string>>) => object) {
  const calls: Array<Readonly<Record<string, string>>> = [];
  const runner: PowerShellRunner = async (_script, env) => {
    calls.push(env);
    return { code: 0, stdout: JSON.stringify(reply(env)), stderr: '' };
  };
  return { runner, calls };
}

/** A detached child that spawns, then (optionally) serves the supervisor pipe. */
function spawner(onSpawn?: () => void) {
  const spawned: Array<{ file: string; args: readonly string[] }> = [];
  const spawnDetached = (file: string, args: readonly string[]) => {
    spawned.push({ file, args });
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as unknown as { unref(): void }).unref = () => {};
    setImmediate(() => {
      child.emit('spawn');
      onSpawn?.();
    });
    return child;
  };
  return { spawnDetached, spawned };
}

describe('the supervisor pipe', () => {
  it('believes only a supervisor that proves it reads the home', async () => {
    const home = freshHome();
    expect(await supervisorRequest(home, 'status')).toEqual({ kind: 'absent' });
    const real = await supervisor(home);
    const answer = await supervisorRequest(home, 'status');
    expect(answer).toMatchObject({ kind: 'answered', state: { pid: 4242, daemon: 4243 } });
    await new Promise<void>((resolve) => real.close(() => resolve()));
    servers.splice(0);
    await supervisor(home, true);
    expect(await supervisorRequest(home, 'status')).toEqual({ kind: 'foreign' });
  });

  it('waits for a silent server rather than calling it absent', async () => {
    const home = freshHome();
    await serve(home, 'supervisor', () => null);
    expect(await supervisorRequest(home, 'status', 300)).toEqual({ kind: 'unavailable' });
  });

  it('tells this home’s connector from a squatter on its lock', async () => {
    const home = freshHome();
    expect(await connectorPipeState(home, 'remote')).toBe('absent');
    await serve(home, 'remote', (request) => ({
      t: 'proven',
      proof: ipcProof(home, 'remote', request.challenge!),
    }));
    expect(await connectorPipeState(home, 'remote')).toBe('proven');
    const other = freshHome();
    await serve(other, 'remote', () => ({ t: 'proven', proof: '0'.repeat(64) }));
    expect(await connectorPipeState(other, 'remote')).toBe('foreign');
  });

  it('finds a squatter on any connector pipe, a registered profile’s included', async () => {
    const home = freshHome();
    const profile = '0123456789';
    mkdirSync(join(home, 'remote', 'profiles', profile), { recursive: true });
    // Not a profile id: never probed.
    mkdirSync(join(home, 'remote', 'profiles', 'not-a-profile'), { recursive: true });
    expect(await connectorPipeSquatted(home)).toBe(false);
    const prove = (scope: string) => (request: Record<string, string>) => ({
      t: 'proven',
      proof: ipcProof(home, scope, request.challenge!),
    });
    await serve(home, 'remote', prove('remote'));
    await serve(home, `remote-${profile}`, prove(`remote-${profile}`));
    expect(await connectorPipeSquatted(home)).toBe(false);

    const squatted = freshHome();
    mkdirSync(join(squatted, 'remote', 'profiles', profile), { recursive: true });
    await serve(squatted, `remote-${profile}`, () => ({ t: 'proven', proof: '0'.repeat(64) }));
    expect(await connectorPipeSquatted(squatted)).toBe(true);
    const locked = freshHome();
    await serve(locked, 'remote', () => ({ t: 'error' }));
    expect(await connectorPipeSquatted(locked)).toBe(true);
  });
});

describe('starting the supervisor', () => {
  it('leaves one that already answers alone', async () => {
    const home = freshHome();
    await supervisor(home);
    const { runner, calls } = powershell(() => ({}));
    expect(await startWindowsSupervisor(home, { task: true, powershell: runner })).toBe('running');
    expect(calls).toEqual([]);
  });

  it('starts it through its scheduled task', async () => {
    const home = freshHome();
    const { runner, calls } = powershell((env) => {
      void supervisor(home);
      return { ran: true, state: 'Running', error: '', name: env.PUDDLE_TASK_NAME };
    });
    expect(
      await startWindowsSupervisor(home, { task: true, powershell: runner, waitMs: 5000 }),
    ).toBe('task');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.PUDDLE_TASK_NAME).toMatch(/^Puddle [0-9a-f]{16}$/);
  });

  it('goes through WMI when the task cannot run without a desktop session', async () => {
    const home = freshHome();
    const lines: string[] = [];
    const { runner, calls } = powershell((env) => {
      if ('PUDDLE_PROCESS_COMMAND' in env) {
        void supervisor(home);
        return { code: 0, pid: 77, error: '' };
      }
      return { ran: false, state: 'Ready', error: '' };
    });
    const started = await startWindowsSupervisor(home, {
      task: true,
      powershell: runner,
      waitMs: 3000,
      logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    });
    expect(started).toBe('process');
    expect(calls[1]!.PUDDLE_PROCESS_COMMAND).toMatch(
      /^"[^"]*\\bin\\current\\bin\\puddle-hidden\.exe" "[^"]*\\node\.exe" ".*supervisor\.mjs" --home "/,
    );
    expect(lines.join('\n')).toMatch(/no desktop session/);
  });

  it('goes to WMI at once when Task Scheduler refused the run, naming its result', async () => {
    const home = freshHome();
    const lines: string[] = [];
    const { runner, calls } = powershell((env) => {
      if ('PUDDLE_PROCESS_COMMAND' in env) {
        void supervisor(home);
        return { code: 0, pid: 77, error: '' };
      }
      // What START reports for a run refused for want of a desktop session.
      return { ran: false, state: 'Ready', lastResult: 0x800710e0, error: '' };
    });
    const begun = Date.now();
    const started = await startWindowsSupervisor(home, {
      task: true,
      powershell: runner,
      waitMs: 20_000,
      logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    });
    expect(started).toBe('process');
    // No wait for a supervisor the refused task never started.
    expect(Date.now() - begun).toBeLessThan(10_000);
    expect(calls.filter((env) => 'PUDDLE_PROCESS_COMMAND' in env)).toHaveLength(1);
    expect(lines.join('\n')).toMatch(
      /the scheduled task did not run \(state ready, last result 0x800710E0\); no desktop session/,
    );
    expect(lines.join('\n')).not.toMatch(/ran, but its supervisor did not come up/);
  });

  it('supervises a home holding % without its task, through WMI or a detached child', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-100%-'));
    const { runner, calls } = powershell((env) => {
      if ('PUDDLE_PROCESS_COMMAND' in env) void supervisor(home);
      return { code: 0, pid: 77, error: '' };
    });
    // Neither registered nor started: Task Scheduler would expand `%…%` in its command.
    expect(
      await startWindowsSupervisor(home, { task: true, powershell: runner, waitMs: 3000 }),
    ).toBe('process');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.PUDDLE_PROCESS_COMMAND).toContain('puddle-100%-');
    expect(calls[0]!.PUDDLE_TASK_NAME).toBeUndefined();

    const detachedHome = mkdtempSync(join(tmpdir(), 'puddle-100%-'));
    const { runner: refused } = powershell(() => ({ code: -1, pid: 0, error: 'Access denied' }));
    const { spawnDetached, spawned } = spawner(() => void supervisor(detachedHome));
    expect(
      await startWindowsSupervisor(detachedHome, {
        task: false,
        powershell: refused,
        spawnDetached,
        waitMs: 3000,
      }),
    ).toBe('detached');
    expect(spawned[0]!.args.at(-1)).toContain('puddle-100%-');
  });

  it('uses a start made with the registration instead of starting the task again', async () => {
    const home = freshHome();
    const { runner, calls } = powershell(() => {
      void supervisor(home);
      return { code: 0, pid: 77, error: '' };
    });
    const started = await startWindowsSupervisor(home, {
      task: true,
      started: { ran: false, state: 'disabled' },
      powershell: runner,
      waitMs: 3000,
    });
    expect(started).toBe('process');
    expect(calls.map((env) => 'PUDDLE_PROCESS_COMMAND' in env)).toEqual([true]);
  });

  it('spawns it detached only when WMI is refused, and fails when nothing brings it up', async () => {
    const home = freshHome();
    const { runner } = powershell(() => ({ code: -1, pid: 0, error: 'Access denied' }));
    const { spawnDetached, spawned } = spawner(() => void supervisor(home));
    expect(
      await startWindowsSupervisor(home, {
        task: false,
        powershell: runner,
        spawnDetached,
        waitMs: 3000,
      }),
    ).toBe('detached');
    expect(spawned[0]!.file).toMatch(/bin\\current\\bin\\node\.exe$/);
    expect(spawned[0]!.args.slice(1)).toEqual(['--home', expect.any(String)]);

    const nothing = freshHome();
    const silent = spawner();
    await expect(
      startWindowsSupervisor(nothing, {
        task: false,
        powershell: runner,
        spawnDetached: silent.spawnDetached,
        waitMs: 300,
      }),
    ).rejects.toThrow('could not be started');
  });

  it('asks a running supervisor to reconcile after remote access is enabled', async () => {
    const home = freshHome();
    requests.length = 0;
    await supervisor(home);
    const { runner, calls } = powershell(() => ({}));
    await superviseWindowsConnector(home, { task: true, powershell: runner });
    expect(requests).toEqual(['reconcile']);
    expect(calls).toEqual([]);
  });

  it('starts the supervisor when none runs to reconcile, and refuses a squatter', async () => {
    const home = freshHome();
    const { runner } = powershell(() => {
      void supervisor(home);
      return { ran: true, state: 'Running', error: '' };
    });
    await superviseWindowsConnector(home, { task: true, powershell: runner, waitMs: 3000 });
    expect((await supervisorRequest(home, 'status')).kind).toBe('answered');

    const squatted = freshHome();
    await supervisor(squatted, true);
    await expect(
      superviseWindowsConnector(squatted, { task: true, powershell: runner }),
    ).rejects.toThrow('held by another program');
  });
});
