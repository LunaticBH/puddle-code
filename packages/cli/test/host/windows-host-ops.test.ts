import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@puddle/shared';
import { ipcPath, ipcProof, listenPrivate } from '@puddle/shared/node';
import type { PowerShellRunner } from '@puddle/shared/node/platform';
import { runWindowsHostOp, testSupervision } from '../../src/lib/host/windows-host-ops.js';
import { parseHelperMessage } from '../../src/lib/host/windows-host-protocol.js';

/**
 * The host helper's operations (src/windows-host.ts), driven in process
 * against a temporary home; ipcPath gives a socket off Windows, so the
 * control channel's proof check runs on every OS.
 */

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

function io() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let text = '';
  stdout.on('data', (chunk: Buffer) => (text += chunk.toString()));
  return {
    stdin,
    stdout,
    lines: () =>
      text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const authority = (proof?: string) => ({
  t: 'authority',
  generation: randomUUID(),
  token: `cn_${'a'.repeat(64)}`,
  validForMs: 45_000,
  port: 7434,
  version: { version: '9.9.9', protocol: PROTOCOL_VERSION },
  ...(proof !== undefined ? { proof } : {}),
});

/** Serve the home's control pipe; records each request it receives. */
async function serve(home: string, reply: (challenge: string | undefined) => object) {
  const requests: Array<Record<string, unknown>> = [];
  server = await listenPrivate(ipcPath(home, 'host'), (socket: Socket) => {
    socket.on('error', () => {});
    socket.on('data', (data: Buffer) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      socket.write(JSON.stringify(reply(request.challenge as string | undefined)) + '\n');
    });
  });
  return requests;
}

const home = () => mkdtempSync(join(tmpdir(), 'puddle-host-op-'));

/** A supervisor answering on the home's supervisor pipe, with its proof. */
function serveSupervisor(home: string): Promise<Server> {
  return listenPrivate(ipcPath(home, 'supervisor'), (socket: Socket) => {
    socket.on('error', () => {});
    socket.once('data', (data: Buffer) => {
      const { challenge } = JSON.parse(data.toString()) as { challenge: string };
      socket.end(
        JSON.stringify({
          t: 'supervisor',
          proof: ipcProof(home, 'supervisor', challenge),
          pid: 4242,
          daemon: null,
          connector: null,
          stopping: false,
        }) + '\n',
      );
    });
  });
}

describe('the control channel a Windows SSH host relays', () => {
  it('challenges the home’s daemon itself and relays a proven answer', async () => {
    const at = home();
    const requests = await serve(at, (challenge) => authority(ipcProof(at, 'host', challenge!)));
    const channel = io();
    const done = runWindowsHostOp('channel', {}, { home: at, ...channel });
    // The client cannot read this host's ipc-key, so it sends no challenge.
    channel.stdin.write(JSON.stringify({ t: 'open' }) + '\n');
    await expect.poll(() => channel.lines().length).toBe(1);
    expect(requests[0]).toMatchObject({
      t: 'open',
      challenge: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(channel.lines()[0]).toMatchObject({ t: 'authority', port: 7434 });
    channel.stdin.end();
    await expect(done).resolves.toBe(0);
  });

  it('refuses a pipe server that cannot prove it reads the home, before relaying a word', async () => {
    const at = home();
    await serve(at, () => authority());
    const channel = io();
    const done = runWindowsHostOp('channel', {}, { home: at, ...channel });
    channel.stdin.write(JSON.stringify({ t: 'open' }) + '\n');
    await expect(done).resolves.toBe(1);
    expect(channel.lines()).toEqual([{ t: 'error', code: 'rejected' }]);
  });

  it('refuses an impostor’s proof for another challenge', async () => {
    const at = home();
    await serve(at, () => authority(ipcProof(at, 'host', 'b'.repeat(64))));
    const channel = io();
    const done = runWindowsHostOp('channel', {}, { home: at, ...channel });
    channel.stdin.write(JSON.stringify({ t: 'open' }) + '\n');
    await expect(done).resolves.toBe(1);
    expect(channel.lines()).toEqual([{ t: 'error', code: 'rejected' }]);
  });
});

describe('the host helper’s other operations', () => {
  it('reports an empty home as having no daemon and nothing installed', async () => {
    const at = home();
    const inspect = io();
    await expect(runWindowsHostOp('inspect', {}, { home: at, ...inspect })).resolves.toBe(0);
    expect(inspect.lines()).toEqual([{ t: 'error', code: 'unavailable' }]);
    const pipe = io();
    await runWindowsHostOp('pipe', {}, { home: at, ...pipe });
    expect(pipe.lines()).toEqual([{ t: 'result', value: 'absent' }]);
    const installed = io();
    await runWindowsHostOp('installed', {}, { home: at, ...installed });
    expect(installed.lines()).toEqual([{ t: 'result', value: null }]);
    const sweep = io();
    await runWindowsHostOp('sweep', {}, { home: at, ...sweep });
    expect(sweep.lines()).toEqual([{ t: 'result', value: [] }]);
  });

  it('keeps the CliError code of a failure, so the client acts on it', async () => {
    const logs = io();
    await expect(
      runWindowsHostOp('logs', { session: 'nope' }, { home: home(), ...logs }),
    ).resolves.toBe(1);
    expect(parseHelperMessage(JSON.stringify(logs.lines()[0]))).toMatchObject({
      t: 'error',
      code: 'unknown_session',
    });
    const install = io();
    await runWindowsHostOp('install', {}, { home: home(), ...install });
    expect(install.lines()[0]).toMatchObject({ t: 'error', code: 'bad_arguments' });
  });

  it('reports the connector of a tree whatever its architecture, as a local host does', async () => {
    const at = home();
    const tree = join(at, 'bin', 'versions', '1.2.3');
    mkdirSync(join(tree, 'daemon'), { recursive: true });
    writeFileSync(join(tree, 'daemon', 'connector.mjs'), '');
    // No node.exe of this machine's build: installation would replace it, but it is what runs.
    symlinkSync(tree, join(at, 'bin', 'current'), 'junction');
    const reply = io();
    await runWindowsHostOp('connector-installed', {}, { home: at, ...reply });
    expect(reply.lines()).toEqual([{ t: 'result', value: { installed: true, version: '1.2.3' } }]);
  });

  it('stops only a daemon pid the home names, and nothing for a malformed one', async () => {
    const at = home();
    const stop = io();
    await runWindowsHostOp('stop-daemon', { pid: 4242 }, { home: at, ...stop });
    expect(stop.lines()).toEqual([{ t: 'result', value: 'named' }]);
    for (const pid of [undefined, 0, -1, 1.5, '4242']) {
      const bad = io();
      await expect(runWindowsHostOp('stop-daemon', { pid }, { home: at, ...bad })).resolves.toBe(1);
      expect(bad.lines()[0]).toMatchObject({ t: 'error', code: 'bad_arguments' });
    }
    // The home's whole stop is no client's to ask for.
    const whole = io();
    await runWindowsHostOp('stop', {}, { home: at, ...whole });
    expect(whole.lines()[0]).toMatchObject({ t: 'error', code: 'bad_arguments' });
  });

  /** `--configure` for a managed (supervised) connector, as `remote enable` asks. */
  function enable(context: Omit<Parameters<typeof runWindowsHostOp>[2], 'stdin' | 'stdout'>) {
    const configure = io();
    const done = runWindowsHostOp(
      'connector',
      { args: ['--configure'] },
      { ...context, ...configure },
    );
    configure.stdin.end(
      JSON.stringify({ profile: 'default', setup: { code: 'c'.repeat(64), managed: true } }) + '\n',
    );
    return { done, lines: configure.lines };
  }

  it('enables supervised remote access only once Task Scheduler or WMI has started the supervisor', async () => {
    // Neither way works here (the test seam refuses both): only then is it refused.
    const { done, lines } = enable({ home: home(), supervision: 'session' });
    await expect(done).resolves.toBe(1);
    expect(lines().at(-1)).toMatchObject({
      t: 'error',
      code: 'session_bound',
      message: expect.stringContaining('neither Task Scheduler nor WMI could start it'),
    });
    // WMI was asked, and no detached child of this session was started instead.
    const log = lines()
      .filter((line) => line.t === 'log')
      .map((line) => String(line.message))
      .join('\n');
    expect(log).toMatch(/WMI could not start the supervisor \(.*WMI is refused in tests/);
    // The registration code never reaches the answer.
    expect(JSON.stringify(lines())).not.toContain('c'.repeat(64));
  });

  it('starts the supervisor through WMI before enabling, as an install does', async () => {
    const at = home();
    const asked: string[] = [];
    const powershell: PowerShellRunner = async (_script, env) => {
      if ('PUDDLE_PROCESS_COMMAND' in env) {
        asked.push(env.PUDDLE_PROCESS_COMMAND!);
        server = await serveSupervisor(at);
        return { code: 0, stdout: JSON.stringify({ code: 0, pid: 4242, error: '' }), stderr: '' };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ ran: false, state: 'absent', error: '' }),
        stderr: '',
      };
    };
    const { done, lines } = enable({ home: at, powershell });
    await done;
    expect(asked).toEqual([expect.stringContaining('supervisor.mjs')]);
    // Past the guard: whatever the (absent) connector then says, it is not session_bound.
    expect(lines().filter((line) => line.code === 'session_bound')).toEqual([]);
  });

  it('refuses remote access beside a daemon attached to an SSH session, starting nothing', async () => {
    const at = home();
    await serve(at, (challenge) => authority(ipcProof(at, 'host', challenge!)));
    let asked = false;
    const powershell: PowerShellRunner = async () => {
      asked = true;
      return { code: 0, stdout: '{}', stderr: '' };
    };
    const { done, lines } = enable({ home: at, powershell });
    await expect(done).resolves.toBe(1);
    expect(lines().at(-1)).toMatchObject({
      code: 'session_bound',
      message: expect.stringContaining('attached to an SSH session'),
    });
    expect(asked).toBe(false);
  });

  it('honours the supervision test seam for a home in the temporary directory only', () => {
    const temp = mkdtempSync(join(tmpdir(), 'puddle-seam-'));
    const env = { PUDDLE_TEST_WINDOWS_SUPERVISION: 'wmi' };
    expect(testSupervision(env, join(temp, 'puddle-test-home'), temp)).toBe('wmi');
    expect(
      testSupervision({ PUDDLE_TEST_WINDOWS_SUPERVISION: 'session' }, join(temp, 'h'), temp),
    ).toBe('session');
    // A real home, beside the temporary directory or above it, is always supervised for real.
    expect(testSupervision(env, join(temp, '..', 'home', '.puddle'), temp)).toBeUndefined();
    expect(testSupervision(env, temp, temp)).toBeUndefined();
    expect(testSupervision(env, join(temp, '..'), temp)).toBeUndefined();
    expect(
      testSupervision({ PUDDLE_TEST_WINDOWS_SUPERVISION: 'task' }, join(temp, 'h'), temp),
    ).toBeUndefined();
    expect(testSupervision({}, join(temp, 'h'), temp)).toBeUndefined();
  });

  it('honours the seam for a home not yet created under a temporary directory spelled through a link', () => {
    // As on GitHub's windows-latest (TEMP=C:\Users\RUNNER~1\…): the first
    // install runs before the home exists, so only its parent has a real path.
    const real = mkdtempSync(join(tmpdir(), 'puddle-seam-real-'));
    mkdirSync(join(real, 'Temp'));
    const link = join(mkdtempSync(join(tmpdir(), 'puddle-seam-link-')), 'short');
    symlinkSync(real, link, 'junction');
    const temp = join(link, 'Temp');
    const env = { PUDDLE_TEST_WINDOWS_SUPERVISION: 'session' };
    expect(testSupervision(env, join(temp, 'puddle-test-home'), temp)).toBe('session');
    expect(testSupervision(env, join(temp, 'not', 'yet', 'here'), temp)).toBe('session');
    // The real spelling of the same directory counts as inside it too.
    expect(testSupervision(env, join(real, 'Temp', 'puddle-test-home'), temp)).toBe('session');
    // Still nothing beside or above it.
    expect(testSupervision(env, join(link, 'home', '.puddle'), temp)).toBeUndefined();
    expect(testSupervision(env, temp, temp)).toBeUndefined();
    expect(testSupervision(env, link, temp)).toBeUndefined();
  });

  it('compares a Windows host’s paths case-insensitively', () => {
    const temp = mkdtempSync(join(tmpdir(), 'puddle-seam-case-'));
    const env = { PUDDLE_TEST_WINDOWS_SUPERVISION: 'wmi' };
    const upper = join(temp, 'PUDDLE-TEST-HOME');
    expect(testSupervision(env, upper.replace(/seam-case/, 'SEAM-CASE'), temp, 'win32')).toBe(
      'wmi',
    );
    expect(testSupervision(env, join(temp, '..'), temp.toUpperCase(), 'win32')).toBeUndefined();
  });

  it('runs only the connector modes a client may ask for', async () => {
    const connector = io();
    await runWindowsHostOp(
      'connector',
      { args: ['--inspect', '--eval=process.exit()'] },
      { home: home(), ...connector },
    );
    expect(connector.lines()[0]).toMatchObject({ t: 'error', code: 'bad_arguments' });
    const unknown = io();
    await expect(
      runWindowsHostOp('exec', { command: 'calc' }, { home: home(), ...unknown }),
    ).resolves.toBe(1);
    expect(unknown.lines()[0]).toMatchObject({ t: 'error', code: 'bad_arguments' });
  });
});
