import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { listWindowsProcesses, type WindowsProcess } from '@puddle/shared/node/platform';
import type { LifecycleLaunchContext } from '../../src/agents/adapter.js';
import {
  admitWithToken,
  HeadlessControl,
  prepareHeadless,
} from '../../src/agents/headless/control.js';
import { codexDriver } from '../../src/agents/codex/headless.js';
import { LogStore } from '../../src/logs/log-store.js';
import { isConptyHelper, sharedConptyJobs } from '../../src/pty/conpty-jobs.js';
import { PtyManager } from '../../src/pty/pty-manager.js';
import { waitFor } from '../helpers/daemon-fixtures.js';
import { stopPtysAfterFile } from '../helpers/process-guard.js';
import {
  attachedGuiProgram,
  guiProgram,
  marked,
  role,
  stillRunning,
  stopMarked,
  survivors,
  waitUntil,
  withRoles,
} from '../helpers/process-trees.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const context: LifecycleLaunchContext = {
  account: {
    id: 1,
    profile_id: '0123456789',
    agent_type: 'codex',
    label: 'test',
    config_dir: '/account',
    logged_in: true,
    skip_permissions_default: false,
    created_at: '',
  },
  opts: { sessionId: randomUUID(), worktreePath: '/work', skipPermissions: false },
  args: [],
  signalNonce: randomUUID(),
  signalUrl: 'http://127.0.0.1/agent-signal',
};

/** A private endpoint for this OS: a named pipe on Windows, a socket elsewhere. */
function endpoint(): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\pudl-test-${randomUUID()}`;
  const dir = mkdtempSync(join(tmpdir(), 'pudl-admit-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 's');
}

async function admissionServer(token: string) {
  const admitted: string[] = [];
  const server: Server = createServer((socket) =>
    admitWithToken(socket, token, (received) => {
      admitted.push(received);
      socket.end('welcome\n');
    }),
  );
  const path = endpoint();
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { path, admitted };
}

async function exchange(path: string, line: string): Promise<string> {
  const client = connect(path);
  let reply = '';
  client.on('data', (chunk: Buffer) => (reply += chunk.toString()));
  client.on('error', () => {});
  client.write(line);
  await once(client, 'close');
  return reply;
}

describe('headless pipe admission', () => {
  it('attaches a connection only once its ready line carries the token', async () => {
    const token = 'a'.repeat(64);
    const server = await admissionServer(token);
    expect(await exchange(server.path, '{"type":"ready","token":"wrong"}\n')).toBe('');
    expect(await exchange(server.path, '{"type":"ready"}\n')).toBe('');
    expect(await exchange(server.path, 'not json\n')).toBe('');
    expect(server.admitted).toEqual([]);
    const ready = `{"type":"ready","token":"${token}"}\n{"type":"interrupt"}\n`;
    expect(await exchange(server.path, ready)).toBe('welcome\n');
    // Everything read during admission reaches the control channel.
    expect(server.admitted).toEqual([ready]);
  });
});

/** A socket stand-in that records what the control writes. */
function recordingSocket(): { socket: Socket; written: () => Array<Record<string, unknown>> } {
  let text = '';
  const duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return {
    socket: duplex as unknown as Socket,
    written: () =>
      text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('headless run requests', () => {
  for (const platform of ['linux', 'win32'] as const) {
    it(`sends the resolved CLI for ${platform}`, async () => {
      const driver = { ...codexDriver(context), binary: process.execPath };
      const control = new HeadlessControl(context, driver, platform);
      const { socket, written } = recordingSocket();
      control.connect(socket, '{"type":"ready"}\n');
      expect(control.ready).toBe(true);
      void control.ask('question', new AbortController().signal).catch(() => {});
      const run = written().find((message) => message['type'] === 'run')!;
      expect(run['binary']).toBe(process.execPath);
      expect(run['args']).toEqual(driver.command(undefined, 'question').args);
      expect(run['env']).toMatchObject({ CODEX_HOME: '/account' });
      expect(run['verbatim']).toBeUndefined();
      control.dispose();
    });
  }

  it('fails the turn before sending anything when a Windows CLI is not on PATH', async () => {
    const driver = { ...codexDriver(context), binary: 'puddle-absent-cli' };
    const control = new HeadlessControl(
      { ...context, env: { PATH: '' } },
      { ...driver, env: { ...driver.env, PATH: '' } },
      'win32',
    );
    const { socket, written } = recordingSocket();
    control.connect(socket, '{"type":"ready"}\n');
    await expect(control.ask('question', new AbortController().signal)).rejects.toThrow(
      "'puddle-absent-cli' was not found on the daemon's PATH",
    );
    expect(written().some((message) => message['type'] === 'run')).toBe(false);
    expect(control.ready).toBe(true);
    control.dispose();
  });
});

describe.runIf(process.platform === 'win32')('Windows headless endpoint', () => {
  it('listens on a named pipe and passes the driver its token', async () => {
    const resource = await prepareHeadless(context, codexDriver(context));
    cleanups.push(() => resource.dispose());
    const [, , path, token] = resource.args;
    expect(path).toMatch(/^\\\\\.\\pipe\\pudl-headless-/);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // A connection without the token is never attached.
    const intruder = connect(path!);
    intruder.on('error', () => {});
    intruder.write('{"type":"ready"}\n');
    await once(intruder, 'close');
    expect(resource.control!.ready).toBe(false);
    const driver = connect(path!);
    let received = '';
    driver.on('data', (chunk: Buffer) => (received += chunk.toString()));
    driver.write(`${JSON.stringify({ type: 'ready', token })}\n`);
    await waitFor(() => resource.control!.ready);
    // Before any run: how the driver starts the ConPTY helper for its CLI's console.
    await waitFor(() => received.includes('\n'));
    const helper = JSON.parse(received.slice(0, received.indexOf('\n'))) as Record<string, unknown>;
    expect(helper).toMatchObject({
      type: 'helper',
      file: expect.stringMatching(/powershell\.exe$/i),
    });
    expect(Object.keys(helper['env'] as object)).toEqual(['PUDDLE_CONPTY_HELPER_SOURCE']);
    driver.destroy();
  });
});

/**
 * `node agent.mjs <marker> <gui.exe> <gui-attach.exe>`: a headless CLI that
 * starts processes attached to its console (a grandchild through a `cmd /c`
 * that waits for it, and an orphan through `cmd /c start /b`, which exits at
 * once: no job holds either, and nothing in the process table leads to the
 * orphan) and processes that left it, or are spared on it (a detached child,
 * a GUI programme through a `cmd /c` that waits for it, one in a console of
 * its own through PowerShell's Start-Process, and a GUI programme that
 * attaches to the console and starts a console child there, through a
 * `cmd /c` that waits for it), then waits, writing nothing. Only the CLI and
 * those processes name the marker on their command lines.
 */
const CLI = String.raw`
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const [marker, gui, attachGui] = process.argv.slice(2);
const node = process.execPath;
const keep = 'setInterval(()=>{},1e9)';
const env = { ...process.env, M: marker, PUDDLE_TREE_MARKER: marker };
const cmd = (line) =>
  spawn(join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d /c ' + line], {
    stdio: 'ignore', windowsVerbatimArguments: true, env,
  });
// (cmd strips the outer quotes of a line that starts with one.)
cmd('""' + node + '" -e "' + keep + '" "%M%:attached""');
cmd('start "" /b "' + node + '" -e "' + keep + '" "%M%:orphan-attached"');
spawn(node, ['-e', keep, marker + ':detached'], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
cmd('""' + gui + '" 120 "%M%:gui""');
cmd('""' + attachGui + '" 120 "' + node + '" -e "' + keep + '" "%M%:gui-child""');
const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// Windows PowerShell's -ArgumentList joins its arguments unquoted: no spaces.
const start = "Start-Process -WindowStyle Hidden '" + node + "' -ArgumentList '-e','" + keep + "',($env:PUDDLE_TREE_MARKER + ':start-process')";
spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', start], { stdio: 'ignore', windowsHide: true, env });
setInterval(() => {}, 1e9);
`;

/** What ends with the CLI's console: the CLI and what is attached to it. */
const ATTACHED = ['agent', 'attached', 'orphan-attached'];
/**
 * What left it, or is a GUI programme's on it, and outlives the session
 * (docs/windows.md, decision 8): `gui-child` names the attaching GUI
 * programme and its console child both.
 */
const LEFT = ['detached', 'gui', 'start-process', 'gui-child', 'gui-child'];

/**
 * The headless CLI runs in a console of its own, which stands for its POSIX
 * process group: however its turn or its session ends, the driver ends the
 * CLI and what is attached to that console, and never a GUI programme, a
 * detached process or one in a console of its own, which a POSIX hang-up
 * spares too. Each test stops the survivors it makes.
 */
describe.runIf(process.platform === 'win32')('a Windows headless CLI’s end', () => {
  const markers: string[] = [];
  afterEach(async () => {
    for (const marker of markers.splice(0)) await stopMarked(marker);
  });

  /** The ConPTY helpers driver `driver` runs. */
  async function helpersOf(driver: number): Promise<WindowsProcess[]> {
    return (await listWindowsProcesses({ fresh: true })).filter(
      (p) => p.ppid === driver && isConptyHelper(p.commandLine ?? ''),
    );
  }

  /**
   * Whether `helper` has started: it lets go of its own console as it
   * begins to serve (FreeConsole, just before it says it is ready), so
   * Windows then names no console host for it.
   */
  async function started(helper: WindowsProcess): Promise<boolean> {
    const held = await sharedConptyJobs().classify([
      { pid: helper.pid, createdAtMs: helper.createdAtMs! },
    ]);
    held?.console.release();
    return held?.processes[0]?.consoleHost === 0;
  }

  /**
   * The driver's one helper, once it has started and so holds the turn's
   * CLI: until then a turn's end ends the CLI alone, after waiting a while
   * for it (terminal-source.ts), which a loaded machine can outlast.
   */
  async function startedHelper(driver: number, unlike?: WindowsProcess): Promise<WindowsProcess> {
    let helper: WindowsProcess | undefined;
    await waitUntil(
      async () => {
        const helpers = await helpersOf(driver);
        helper = helpers.length === 1 ? helpers[0] : undefined;
        if (!helper || helper.createdAtMs === unlike?.createdAtMs) return false;
        return started(helper);
      },
      30_000,
      unlike ? 'a helper in its place' : 'its helper',
    );
    return helper!;
  }

  /**
   * The driver in a real PTY, running a turn of the CLI above; resolves once
   * its whole tree runs and its helper has started. `starting` runs on its
   * first helper as soon as it is seen.
   */
  async function headlessTree(starting?: (helper: WindowsProcess) => Promise<void>) {
    const marker = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
    markers.push(marker);
    const script = join(marker, 'agent.mjs');
    writeFileSync(script, CLI);
    const programs = [await guiProgram(), await attachedGuiProgram()];
    const resource = await prepareHeadless(context, {
      ...codexDriver(context),
      binary: process.execPath,
      command: () => ({ args: [script, marker, ...programs], stdin: '' }),
    });
    cleanups.push(() => resource.dispose());
    const ptys = new PtyManager(new LogStore(mkdtempSync(join(tmpdir(), 'puddle-logs-')), 65536));
    stopPtysAfterFile(ptys);
    await ptys.prepare();
    ptys.spawn('h', 'agent', resource.binary!, resource.args, { cwd: marker });
    const control = resource.control!;
    await waitFor(() => control.ready);
    const abort = new AbortController();
    const turn = control.ask('question', abort.signal);
    turn.catch(() => {});
    const driver = ptys.pidFor('h', 'agent')!;
    if (starting) {
      let first: WindowsProcess | undefined;
      await waitUntil(
        async () => (first = (await helpersOf(driver))[0]) !== undefined,
        30_000,
        'its helper',
      );
      await starting(first!);
    }
    let members: WindowsProcess[] = [];
    await waitUntil(
      async () => (members = await marked(marker)).length === ATTACHED.length + LEFT.length,
      30_000,
      'the whole tree',
    );
    const helper = await startedHelper(driver);
    const exited = new Promise<void>((resolve) => ptys.once('exit', () => resolve()));
    return {
      ptys,
      control,
      abort,
      turn,
      exited,
      driver,
      helper,
      dispose: () => resource.dispose(),
      attached: withRoles(members, ATTACHED),
      left: withRoles(members, LEFT),
    };
  }

  it('the session’s end ends what is attached to the CLI’s console, and nothing that left it', async () => {
    const { ptys, exited, attached, left } = await headlessTree();
    expect(attached.map(role).sort()).toEqual([...ATTACHED].sort());
    ptys.kill('h', 'agent');
    await exited;
    expect(await survivors(attached)).toEqual([]);
    expect((await stillRunning(left)).map(role).sort()).toEqual([...LEFT].sort());
  });

  it('a cancelled turn ends what is attached to the CLI’s console before the next, and nothing that left it', async () => {
    const { control, abort, turn, attached, left } = await headlessTree();
    abort.abort();
    await expect(turn).rejects.toThrow('cancelled');
    expect(await survivors(attached)).toEqual([]);
    expect((await stillRunning(left)).map(role).sort()).toEqual([...LEFT].sort());
    expect(control.ready).toBe(true);
  });

  it('replaces a ConPTY helper that exits mid-turn, which still ends what is attached to the CLI’s console', async () => {
    const { control, abort, turn, driver, helper, attached, left } = await headlessTree();
    // As an agent's `Stop-Process -Name powershell` would.
    process.kill(helper.pid);
    await startedHelper(driver, helper);
    abort.abort();
    await expect(turn).rejects.toThrow('cancelled');
    expect(await survivors(attached)).toEqual([]);
    expect((await stillRunning(left)).map(role).sort()).toEqual([...LEFT].sort());
    expect(control.ready).toBe(true);
  });

  it('replaces a ConPTY helper that exits as it starts, which still ends what is attached to the CLI’s console', async () => {
    // Such a Stop-Process may catch the helper while it compiles, which is
    // no sign that it cannot start.
    let first: WindowsProcess | undefined;
    const { control, abort, turn, helper, attached, left } = await headlessTree(async (seen) => {
      first = seen;
      expect(await started(seen)).toBe(false);
      process.kill(seen.pid);
    });
    expect(helper.createdAtMs).not.toBe(first!.createdAtMs);
    abort.abort();
    await expect(turn).rejects.toThrow('cancelled');
    expect(await survivors(attached)).toEqual([]);
    expect((await stillRunning(left)).map(role).sort()).toEqual([...LEFT].sort());
    expect(control.ready).toBe(true);
  });

  it('the daemon’s going ends what is attached to the CLI’s console, and nothing that left it', async () => {
    const { dispose, exited, attached, left } = await headlessTree();
    // The driver's socket closes, as when the daemon has gone.
    await dispose();
    await exited;
    expect(await survivors(attached)).toEqual([]);
    expect((await stillRunning(left)).map(role).sort()).toEqual([...LEFT].sort());
  });
});
