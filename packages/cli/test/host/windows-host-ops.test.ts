import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@puddle/shared';
import { ipcPath, ipcProof, listenPrivate } from '@puddle/shared/node';
import { runWindowsHostOp } from '../../src/lib/host/windows-host-ops.js';
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

  it('enables supervised remote access only with a supervisor running outside the session', async () => {
    const at = home();
    const configure = io();
    const done = runWindowsHostOp(
      'connector',
      { args: ['--configure'] },
      { home: at, ...configure },
    );
    configure.stdin.end(
      JSON.stringify({ profile: 'default', setup: { code: 'c'.repeat(64), managed: true } }) + '\n',
    );
    await expect(done).resolves.toBe(1);
    expect(configure.lines()).toEqual([
      expect.objectContaining({ t: 'error', code: 'session_bound' }),
    ]);
    // The registration code never reaches the answer.
    expect(JSON.stringify(configure.lines())).not.toContain('c'.repeat(64));
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
