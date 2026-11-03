import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { LifecycleLaunchContext } from '../../src/agents/adapter.js';
import {
  admitWithToken,
  HeadlessControl,
  prepareHeadless,
} from '../../src/agents/headless/control.js';
import { codexDriver } from '../../src/agents/codex/headless.js';
import { waitFor } from '../helpers/daemon-fixtures.js';

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
    driver.write(`${JSON.stringify({ type: 'ready', token })}\n`);
    await waitFor(() => resource.control!.ready);
    driver.destroy();
  });
});
