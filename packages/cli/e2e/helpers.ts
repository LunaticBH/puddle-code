import { spawn, fork, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { cockpitStatusSchema, type WsServerMessage } from '@puddle/shared';
import { listWindowsProcesses, stopWindowsProcessTree } from '@puddle/shared/node/platform';
import { reapExited, tracked } from '../../daemon/test/helpers/child-lifetimes.js';
import { onTeardown } from '../../daemon/test/helpers/process-guard.js';
import { findFreePort } from '../src/lib/transport/net.js';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function until<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeout = 30_000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await sleep(50);
  }
  throw new Error('Readiness deadline exceeded');
}
export function env(home: string): NodeJS.ProcessEnv {
  // Deliberate allowlist: no inherited orchestration, account or agent credentials.
  return {
    PATH: process.env.PATH,
    SHELL: '/bin/sh',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    PUDDLE_HOME: home,
  };
}
const windows = process.platform === 'win32';
/** Records when each child started and exited: the bounds that recognise its orphans. */
const track = tracked;

/**
 * Stops a child and waits for its exit. Windows has no SIGTERM from another
 * process (`kill` is TerminateProcess): a fixture daemon is asked over its
 * IPC channel, so it stops its PTYs as on POSIX, and once the child has
 * exited, whatever it left running is stopped too, once: children of its
 * pid created after it exited are a later holder's.
 */
export async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  if (child.exitCode === null && child.signalCode === null) {
    if (windows && signal === 'SIGTERM' && child.connected) {
      child.send({ t: 'stop' });
      const timer = setTimeout(() => child.kill(), 30_000);
      await exited;
      clearTimeout(timer);
    } else {
      child.kill(signal);
    }
  }
  await exited;
  if (windows) {
    await reapExited(child, ({ pid, startedAtMs, exitedAtMs }) =>
      stopWindowsProcessTree(pid, {
        processes: listWindowsProcesses,
        root: { startedAtMs, exitedAtMs },
      }),
    );
  }
}
export async function startFixtureDaemon(home: string) {
  // The home names the daemon's command line for the run's process guard.
  const daemon = track(() =>
    fork(resolve(root, 'packages/cli/e2e/fixtures/daemon.mjs'), [home], {
      env: env(home),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }),
  );
  // A test that fails before its own stop still stops it with the file.
  onTeardown(() => stop(daemon));
  let daemonLog = '';
  daemon.stdout!.on('data', (c) => (daemonLog += String(c)));
  daemon.stderr!.on('data', (c) => (daemonLog += String(c)));
  const port = await new Promise<number>((resolve, reject) => {
    daemon.once('message', (value) => resolve((value as { port: number }).port));
    daemon.once('exit', () => reject(new Error('Fixture daemon failed: ' + daemonLog)));
  });
  return { daemon, port };
}
export async function fixture(options: { caCert?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-auth-e2e-'));
  const { daemon, port } = await startFixtureDaemon(home);
  const uiPort = await findFreePort();
  const origin = `http://localhost:${uiPort}`;
  const launch = () => {
    const child = track(() =>
      spawn(
        process.execPath,
        [
          resolve(root, 'packages/cli/dist/index.js'),
          'launch',
          '--foreground',
          '--no-browser',
          '--no-upgrade',
          '--port',
          String(uiPort),
        ],
        {
          env: {
            ...env(home),
            ...(options.caCert ? { NODE_EXTRA_CA_CERTS: options.caCert } : {}),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
    let output = '';
    child.stdout.on('data', (c) => (output += String(c)));
    child.stderr.on('data', (c) => (output += String(c)));
    return { child, output: () => output };
  };
  const cockpit = launch();
  onTeardown(() => stop(cockpit.child));
  const invitation = await until(
    () => /#invite=(iv_[a-f0-9]{64})/.exec(cockpit.output())?.[1],
    (value) => !!value,
  );
  const exchange = async (value: string) =>
    fetch(`${origin}/cockpit/bootstrap`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ invitation: value }),
    });
  const response = await exchange(invitation!);
  if (!response.ok) throw new Error('Invitation exchange failed');
  const credential = ((await response.json()) as { credential: string }).credential;
  const req = (path: string, init: RequestInit = {}, cred = credential) =>
    fetch(origin + path, {
      ...init,
      headers: {
        origin,
        authorization: `Bearer ${cred}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  return {
    home,
    daemon,
    port,
    uiPort,
    origin,
    cockpit,
    credential,
    invitation: invitation!,
    exchange,
    launch,
    req,
    state: async () => cockpitStatusSchema.parse(await (await req('/cockpit/status')).json()),
    registry: () =>
      JSON.parse(readFileSync(join(home, 'cockpits/local.json'), 'utf8')) as {
        pid: number;
        launcherPath: string;
        nonce: string;
      },
    async close() {
      // A refresh created a different process; stop the registered replacement too.
      try {
        const record = this.registry();
        if (record.pid !== cockpit.child.pid) process.kill(record.pid, 'SIGTERM');
      } catch {
        /* Already stopped. */
      }
      await stop(cockpit.child);
      await stop(daemon);
    },
  };
}
export async function websocket(origin: string, credential: string) {
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin });
  const messages: WsServerMessage[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as WsServerMessage));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ t: 'auth', token: credential }));
  await until(() => messages.some((m) => m.t === 'authenticated'), Boolean);
  return {
    ws,
    messages,
    send: (message: object) => ws.send(JSON.stringify(message)),
    close: () => ws.terminate(),
  };
}
export function repository(home: string): string {
  const path = join(home, 'repo');
  mkdirSync(path);
  execFileSync('git', ['init', '-b', 'main', path], { stdio: 'ignore' });
  execFileSync(
    'git',
    [
      '-C',
      path,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'Initial fixture',
    ],
    { stdio: 'ignore' },
  );
  return path;
}

export async function createSession(f: Awaited<ReturnType<typeof fixture>>) {
  const post = async (path: string, body: object) => {
    const response = await f.req(path, { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<Record<string, string | number>>;
  };
  const profile = await post('/api/profiles', { name: 'test' });
  const repo = await post('/api/repos', { path: repository(f.home) });
  const project = await post('/api/projects', {
    name: 'fixture',
    profile_id: profile.id,
    repo_id: repo.id,
  });
  const account = await post('/api/accounts', {
    profile_id: profile.id,
    agent_type: 'fake',
    label: 'test',
  });
  return post('/api/sessions', {
    project_id: project.id,
    account_id: account.id,
    separate_branch: false,
    separate_directory: false,
  });
}
