import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ipcPath, ipcProof, listenPrivate } from '@puddle/shared/node';
import { isPidAlive, type WindowsProcess } from '@puddle/shared/node/platform';
import {
  controlPipePresent,
  controlPipeState,
  daemonEnvironment,
  isHomeDaemon,
  isHomeSupervisor,
  requestDaemonShutdown,
  stopWindowsDaemon,
  stopWindowsSupervisor,
  windowsRuntime,
} from '../../src/lib/installation/windows-daemon.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** The proof the home's daemon adds to its answer to `request`; none without a challenge. */
function proofFor(home: string, request: Buffer): { proof?: string } {
  const { challenge } = JSON.parse(request.toString()) as { challenge?: string };
  return challenge === undefined ? {} : { proof: ipcProof(home, 'host', challenge) };
}

/**
 * A stand-in for the daemon's control endpoint that answers every line with
 * `reply`, proving it can read the home unless it is an `impostor`.
 */
async function control(
  home: string,
  reply: object | null,
  onRequest?: () => void,
  impostor = false,
) {
  const server = await listenPrivate(ipcPath(home, 'host'), (socket) => {
    socket.on('error', () => {});
    socket.on('data', (request: Buffer) => {
      onRequest?.();
      const proof = impostor ? {} : proofFor(home, request);
      if (reply) socket.end(JSON.stringify({ ...reply, ...proof }) + '\n');
    });
  });
  servers.push(server);
  return server;
}

function process_(pid: number, commandLine: string | null, name = 'node.exe'): WindowsProcess {
  return {
    pid,
    ppid: 1,
    name,
    command: name.replace(/\.exe$/i, '').toLowerCase(),
    commandLine,
    createdAtMs: 0,
  };
}

describe('the detached Windows supervisor', () => {
  it('runs the versioned runtime, never the caller’s own executable', () => {
    expect(windowsRuntime('C:\\Users\\a\\.puddle', '0.3.14')).toEqual({
      dir: 'C:\\Users\\a\\.puddle\\bin\\versions\\0.3.14',
      node: 'C:\\Users\\a\\.puddle\\bin\\versions\\0.3.14\\bin\\node.exe',
      entry: 'C:\\Users\\a\\.puddle\\bin\\versions\\0.3.14\\daemon\\puddled.mjs',
    });
  });

  it('starts the daemon without agent-orchestration or CLI-internal variables', () => {
    const env = daemonEnvironment({
      Path: 'C:\\Windows',
      PUDDLE_HOME: 'C:\\h',
      claudecode: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      Claude_Code_SSE_PORT: '1',
      PUDDLE_COCKPIT_CHILD: '1',
      PUDDLE_REFRESH_ID: 'x',
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(env).toEqual({
      Path: 'C:\\Windows',
      PUDDLE_HOME: 'C:\\h',
      NoDefaultCurrentDirectoryInExePath: 'puddle',
    });
  });

  it('passes an overridden home on absolute, since the daemon runs elsewhere', () => {
    expect(daemonEnvironment({ puddle_home: '.puddle-dev' }, 'C:\\work\\.puddle-dev')).toEqual({
      puddle_home: 'C:\\work\\.puddle-dev',
      NoDefaultCurrentDirectoryInExePath: 'puddle',
    });
    // The default home stays implicit, as under a POSIX supervisor.
    expect(daemonEnvironment({ Path: 'C:\\Windows' }, 'C:\\Users\\a\\.puddle')).toEqual({
      Path: 'C:\\Windows',
      NoDefaultCurrentDirectoryInExePath: 'puddle',
    });
  });

  it('starts the daemon with the working-directory program search off, keeping a user value', () => {
    // libuv would otherwise look for a bare `git` in each worktree before PATH.
    expect(daemonEnvironment({}).NoDefaultCurrentDirectoryInExePath).toBe('puddle');
    expect(daemonEnvironment({ nodefaultcurrentdirectoryinexepath: 'yes' })).toEqual({
      nodefaultcurrentdirectoryinexepath: 'yes',
    });
  });

  it('recognises only this home’s daemons, by their command line', () => {
    const home = 'C:\\Users\\a\\.puddle';
    const daemon =
      '"C:\\Users\\a\\.puddle\\bin\\versions\\0.3.14\\bin\\node.exe" ' +
      'C:\\Users\\a\\.puddle\\bin\\versions\\0.3.14\\daemon\\puddled.mjs';
    expect(isHomeDaemon(process_(10, daemon), home)).toBe(true);
    expect(isHomeDaemon(process_(10, daemon.toUpperCase()), home)).toBe(true);
    expect(isHomeDaemon(process_(10, daemon.replace(/\\/g, '/')), home)).toBe(true);
    // A recycled pid, another user's process, another home, another program.
    expect(isHomeDaemon(process_(10, 'node C:\\work\\server.mjs'), home)).toBe(false);
    expect(isHomeDaemon(process_(10, null), home)).toBe(false);
    expect(isHomeDaemon(process_(10, daemon.replaceAll('.puddle', '.puddle2')), home)).toBe(false);
    expect(isHomeDaemon(process_(10, daemon, 'pwsh.exe'), home)).toBe(false);
    expect(isHomeDaemon(process_(10, daemon.replace('puddled.mjs', 'connector.mjs')), home)).toBe(
      false,
    );
  });

  it('recognises this home’s supervisors, which are never its daemons', () => {
    const home = 'C:\\Users\\a\\.puddle';
    const task =
      '"C:\\Users\\a\\.puddle\\bin\\current\\bin\\node.exe" ' +
      '"C:\\Users\\a\\.puddle\\bin\\current\\daemon\\supervisor.mjs" --home "C:\\Users\\a\\.puddle"';
    expect(isHomeSupervisor(process_(10, task), home)).toBe(true);
    expect(
      isHomeSupervisor(process_(10, task.replaceAll('current', 'versions\\0.3.15')), home),
    ).toBe(true);
    expect(isHomeDaemon(process_(10, task), home)).toBe(false);
    expect(isHomeSupervisor(process_(10, task.replaceAll('.puddle', '.puddle2')), home)).toBe(
      false,
    );
    // The windowless launcher the task starts names the supervisor too, but is not one.
    const launcher = `"C:\\Users\\a\\.puddle\\bin\\current\\bin\\puddle-hidden.exe" ${task}`;
    expect(isHomeSupervisor(process_(10, launcher, 'puddle-hidden.exe'), home)).toBe(false);
    expect(isHomeSupervisor(process_(10, null), home)).toBe(false);
    expect(
      isHomeSupervisor(process_(10, task.replace('supervisor.mjs', 'puddled.mjs')), home),
    ).toBe(false);
  });

  it('ends the supervisor before the daemon, so nothing starts the daemon again', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-windows-daemon-'));
    const order: string[] = [];
    const supervisor = await listenPrivate(ipcPath(home, 'supervisor'), (socket) => {
      socket.on('error', () => {});
      socket.once('data', (request: Buffer) => {
        const { t, challenge } = JSON.parse(request.toString()) as { t: string; challenge: string };
        order.push(`supervisor ${t}`);
        socket.end(
          JSON.stringify({
            t: 'supervisor',
            proof: ipcProof(home, 'supervisor', challenge),
            pid: 999_999_999,
            daemon: null,
            connector: null,
            stopping: t === 'shutdown',
          }) + '\n',
        );
        // It stops shortly after answering.
        if (t === 'shutdown') setTimeout(() => supervisor.close(), 200);
      });
    });
    await control(home, { t: 'shutting_down' }, () => order.push('daemon shutdown'));
    const lines: string[] = [];
    await stopWindowsDaemon(home, {
      list: async () => [],
      graceMs: 300,
      terminateGraceMs: 300,
      logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    }).catch(() => undefined);
    expect(order[0]).toBe('supervisor shutdown');
    expect(order).toContain('daemon shutdown');
    expect(lines[0]).toBe('stopping the Puddle supervisor on this machine');
  });

  it('leaves no supervisor to stop when none runs or answers for this home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-windows-daemon-'));
    await stopWindowsSupervisor(home, { list: async () => [] });
    // Another home's supervisor is never this one's.
    await stopWindowsSupervisor(home, {
      list: async () => [
        process_(11, 'node C:\\Users\\b\\.puddle\\bin\\current\\daemon\\supervisor.mjs'),
      ],
    });
  });

  it('asks the daemon to stop over its control endpoint', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-windows-daemon-'));
    expect(await requestDaemonShutdown(home)).toBe('absent');
    await control(home, { t: 'shutting_down' });
    expect(await requestDaemonShutdown(home)).toBe('stopping');
  });

  it('tells an older daemon from a starting or silent one, and neither from an absent one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-windows-daemon-'));
    await control(home, { t: 'error', code: 'invalid_control' });
    expect(await requestDaemonShutdown(home)).toBe('unsupported');
    const starting = mkdtempSync(join(tmpdir(), 'puddle-windows-daemon-'));
    await control(starting, { t: 'error', code: 'unavailable' });
    expect(await requestDaemonShutdown(starting)).toBe('unavailable');
    const silent = mkdtempSync(join(tmpdir(), 'puddle-windows-daemon-'));
    await control(silent, null);
    expect(await requestDaemonShutdown(silent, 300)).toBe('unavailable');
  });

  it('believes only a pipe server that proves it can read the home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-windows-daemon-'));
    expect(await controlPipeState(home)).toBe('absent');
    const starting = await control(home, { t: 'error', code: 'unavailable' });
    expect(await controlPipeState(home)).toBe('daemon');
    expect(await controlPipePresent(home)).toBe(true);
    await new Promise<void>((resolve) => starting.close(() => resolve()));
    servers.splice(servers.indexOf(starting), 1);

    // Another account squatting a name it saw: it can say anything but the proof.
    await control(home, { t: 'shutting_down' }, undefined, true);
    expect(await controlPipeState(home)).toBe('foreign');
    expect(await controlPipePresent(home)).toBe(false);
    expect(await requestDaemonShutdown(home)).toBe('foreign');
    // Nothing of this home's is running, so there is nothing to stop or wait for.
    writeFileSync(join(home, 'puddled.pid'), '4242\n');
    await stopWindowsDaemon(home, { list: async () => [] });
    expect(existsSync(join(home, 'puddled.pid'))).toBe(false);
  });

  it('waits for a pipe that answers nothing, never replacing it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-windows-daemon-'));
    await control(home, null);
    expect(await controlPipeState(home, 300)).toBe('unknown');
  });

  it('waits for a starting daemon to accept the shutdown rather than terminating it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-windows-daemon-'));
    let requests = 0;
    const server = await listenPrivate(ipcPath(home, 'host'), (socket) => {
      socket.on('error', () => {});
      socket.on('data', (request: Buffer) => {
        requests++;
        const proof = proofFor(home, request);
        if (requests < 3) {
          socket.end(JSON.stringify({ t: 'error', code: 'unavailable', ...proof }) + '\n');
          return;
        }
        socket.end(JSON.stringify({ t: 'shutting_down', ...proof }) + '\n');
        server.close();
      });
    });
    servers.push(server);
    const lines: string[] = [];
    await stopWindowsDaemon(home, {
      list: async () => [],
      logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    });
    expect(requests).toBe(3);
    expect(lines).toEqual(['stopping puddled on this machine']);
  });

  it('waits for a stopping daemon to release its endpoint, then forgets its pid', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-windows-daemon-'));
    writeFileSync(join(home, 'puddled.pid'), '4242\n');
    const server = await control(home, { t: 'shutting_down' }, () => {
      setTimeout(() => {
        servers.splice(servers.indexOf(server), 1);
        server.close();
      }, 300);
    });
    await stopWindowsDaemon(home, { list: async () => [] });
    expect(existsSync(join(home, 'puddled.pid'))).toBe(false);
  });

  it('never terminates what it cannot identify, and says so', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-windows-daemon-'));
    await control(home, { t: 'error', code: 'invalid_control' });
    await expect(
      stopWindowsDaemon(home, {
        list: async () => [process_(99, 'node C:\\elsewhere\\puddled.mjs')],
        terminateGraceMs: 300,
      }),
    ).rejects.toMatchObject({ code: 'daemon_unreachable' });
  });

  it.runIf(process.platform === 'win32')(
    'terminates an identified daemon that does not serve its endpoint',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'puddle-windows-daemon-'));
      const entry = windowsRuntime(home, '1.0.0').entry;
      mkdirSync(join(entry, '..'), { recursive: true });
      // Wedged before it served its pipe: alive, but never answering.
      writeFileSync(entry, 'setInterval(() => {}, 1000);\n');
      const wedged = spawn(process.execPath, [entry], { stdio: 'ignore', windowsHide: true });
      await new Promise((resolve) => wedged.once('spawn', resolve));
      try {
        await stopWindowsDaemon(home, { startingGraceMs: 1000, terminateGraceMs: 10_000 });
        expect(isPidAlive(wedged.pid!, 'win32')).toBe(false);
      } finally {
        wedged.kill();
      }
    },
    30_000,
  );
});
