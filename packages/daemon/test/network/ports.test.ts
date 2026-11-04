import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sessionPortsResponseSchema } from '@puddle/shared';
import { ApiError } from '../../src/http/errors.js';
import { sessionRoutes } from '../../src/http/routes/sessions.js';
import type { WindowsProcess } from '@puddle/shared/node/platform';
import { descendantsOf, parsePsOutput, windowsDescendants } from '../../src/ports/process-tree.js';
import {
  parseLsofOutput,
  parseNetstatOutput,
  parseSsOutput,
  PortScanner,
  type Listener,
} from '../../src/ports/scanner.js';
import type { PtyManager } from '../../src/pty/pty-manager.js';
import { fixture, waitFor, type Fixture } from '../helpers/daemon-fixtures.js';

// node:child_process's execFile is spied on (not stubbed) so real callers —
// PortScanner's own listener/ps execs, git, node-pty — behave identically
// unless a test overrides the implementation for a single call. Named-export
// spies on ESM builtins fail ("module namespace is not configurable"), so
// the whole module is re-exported with `execFile` wrapped in `vi.fn`.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe('parseLsofOutput', () => {
  it('parses two processes, one with multiple sockets (IPv4, IPv6, wildcard)', () => {
    const stdout = [
      'p100',
      'cnode',
      'n127.0.0.1:5173',
      'p200',
      'cpython',
      'f13', // fd line interspersed before the socket lines — verified live on macOS
      'n*:8080',
      'n[::1]:3000',
    ].join('\n');

    expect(parseLsofOutput(stdout)).toEqual([
      { pid: 100, command: 'node', port: 5173, address: '127.0.0.1' },
      { pid: 200, command: 'python', port: 8080, address: '*' },
      { pid: 200, command: 'python', port: 3000, address: '::1' },
    ] satisfies Listener[]);
  });

  it('returns [] for empty stdout', () => {
    expect(parseLsofOutput('')).toEqual([]);
  });
});

describe('parseSsOutput', () => {
  it('parses 0.0.0.0:, [::]:, and *: forms, the first pid of a multi-pid blob, and skips users-less lines', () => {
    const stdout = [
      'LISTEN 0      128          0.0.0.0:3000        0.0.0.0:*    users:(("node",pid=100,fd=20))',
      'LISTEN 0      128             [::]:3000           [::]:*    users:(("node",pid=101,fd=21),("node",pid=102,fd=22))',
      'LISTEN 0      128                *:8080               *:*    users:(("python",pid=200,fd=5))',
      'LISTEN 0      128          127.0.0.1:9999       0.0.0.0:*', // no users blob (no permission) — skipped
    ].join('\n');

    expect(parseSsOutput(stdout)).toEqual([
      { pid: 100, command: 'node', port: 3000, address: '0.0.0.0' },
      { pid: 101, command: 'node', port: 3000, address: '::' },
      { pid: 200, command: 'python', port: 8080, address: '*' },
    ] satisfies Listener[]);
  });

  it('returns [] for empty stdout', () => {
    expect(parseSsOutput('')).toEqual([]);
  });
});

describe('parseNetstatOutput', () => {
  it('keeps TCP listeners by foreign address, whatever the localised state says', () => {
    const stdout = [
      '',
      'Aktive Verbindungen',
      '',
      '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN          1508',
      '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING        4200',
      '  TCP    127.0.0.1:5173         127.0.0.1:50122        ESTABLISHED      4200',
      '  TCP    [::]:3000              [::]:0                 LISTENING        4300',
      '  TCP    [::1]:8080             [::]:0                 LISTENING        4400',
      '  TCP    [fe80::1%12]:9000      [::]:0                 LISTENING        4500',
      '  UDP    0.0.0.0:5353           *:*                                    4600',
      'garbage',
    ].join('\r\n');
    const names = new Map([
      [4200, 'node'],
      [4300, 'python'],
    ]);
    expect(parseNetstatOutput(stdout, (pid) => names.get(pid) ?? '')).toEqual([
      { pid: 1508, command: '', port: 135, address: '0.0.0.0' },
      { pid: 4200, command: 'node', port: 5173, address: '127.0.0.1' },
      { pid: 4300, command: 'python', port: 3000, address: '::' },
      { pid: 4400, command: '', port: 8080, address: '::1' },
      { pid: 4500, command: '', port: 9000, address: 'fe80::1' },
    ] satisfies Listener[]);
  });
});

describe('windowsDescendants', () => {
  const entry = (pid: number, ppid: number, createdAtMs: number | null): WindowsProcess => ({
    pid,
    ppid,
    name: 'node.exe',
    command: 'node',
    commandLine: null,
    createdAtMs,
  });

  it('follows parent links only to processes not older than their parent', () => {
    const table = [
      entry(0, 0, null), // System Idle Process: its own parent
      entry(100, 1, 1_000),
      entry(101, 100, 1_100),
      entry(102, 101, 1_200),
      entry(103, 100, 900), // started before 100: an earlier owner's orphan
      entry(104, 103, 950),
      entry(105, 100, null), // creation time withheld: trusted, as on POSIX
      entry(200, 1, 1_000),
    ];
    expect(windowsDescendants([100], table)).toEqual(new Set([100, 101, 102, 105]));
    expect(windowsDescendants([0], table)).toEqual(new Set([0]));
  });

  it('follows no children of a root missing from the table', () => {
    // 900 is a sidecar that has exited, or a PTY spawned after the table was
    // read: 4000 may be an earlier holder's orphan, and nothing can tell.
    const table = [entry(700, 1, 1_000), entry(4000, 900, 1_000), entry(4001, 4000, 1_100)];
    expect(windowsDescendants([700, 900], table)).toEqual(new Set([700, 900]));
    expect(windowsDescendants([900], table)).toEqual(new Set([900]));
  });

  it('reads the process table instead of exec-ing ps on Windows', async () => {
    vi.mocked(execFile).mockClear();
    const tree = await descendantsOf([100], {
      platform: 'win32',
      windowsProcesses: async () => [entry(100, 1, 1), entry(101, 100, 2)],
    });
    expect(tree).toEqual(new Set([100, 101]));
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('parsePsOutput', () => {
  it('builds a ppid -> children map, skipping malformed lines', () => {
    const stdout = [
      '    1     0',
      '  100     1',
      '  101   100',
      '  102   100',
      '  103   101',
      '  200     1',
      'garbage line',
      '',
    ].join('\n');

    const map = parsePsOutput(stdout);
    expect([...(map.get(1) ?? [])].sort((a, b) => a - b)).toEqual([100, 200]);
    expect([...(map.get(100) ?? [])].sort((a, b) => a - b)).toEqual([101, 102]);
    expect(map.get(101)).toEqual([103]);
  });
});

describe('descendantsOf', () => {
  it('BFS-includes every descendant (incl. grandchildren) and excludes orphans', async () => {
    const psFixture = [
      '    1     0',
      '  100     1',
      '  101   100',
      '  102   100',
      '  103   101',
      '  200     1', // unrelated tree — must not appear
      '',
    ].join('\n');

    vi.mocked(execFile).mockImplementationOnce(((
      _cmd: string,
      _args: string[],
      optsOrCb: unknown,
      cb?: unknown,
    ) => {
      const callback = (typeof optsOrCb === 'function' ? optsOrCb : cb) as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      callback(null, psFixture, '');
      return {} as ChildProcess;
    }) as unknown as typeof execFile);

    const result = await descendantsOf([100], { platform: 'linux' });
    expect(result).toEqual(new Set([100, 101, 102, 103]));
  });

  it('returns an empty set with zero execs when roots is empty', async () => {
    vi.mocked(execFile).mockClear();
    const result = await descendantsOf([]);
    expect(result).toEqual(new Set());
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('PortScanner cache', () => {
  function countingLister(result: Listener[] = []) {
    let calls = 0;
    const lister = async (): Promise<Listener[]> => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return result;
    };
    return { lister, calls: () => calls };
  }

  const stubPtys = { pidsFor: () => [process.pid] } as unknown as PtyManager;

  it('dedupes concurrent scan() calls into a single exec', async () => {
    const { lister, calls } = countingLister();
    const scanner = new PortScanner({ ptys: stubPtys, lister });
    const [a, b] = await Promise.all([scanner.scan('s1'), scanner.scan('s1')]);
    expect(a).toEqual(b);
    expect(calls()).toBe(1);
  });

  it('expires the cache after ttlMs and re-execs', async () => {
    const { lister, calls } = countingLister();
    const scanner = new PortScanner({ ptys: stubPtys, lister, ttlMs: 30 });
    await scanner.scan('s2');
    expect(calls()).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    await scanner.scan('s2');
    expect(calls()).toBe(2);
  });

  it('fresh: true bypasses a live cache entry', async () => {
    const { lister, calls } = countingLister();
    const scanner = new PortScanner({ ptys: stubPtys, lister, ttlMs: 5000 });
    await scanner.scan('s3');
    await scanner.scan('s3'); // cache hit, still 1 call
    expect(calls()).toBe(1);
    await scanner.scan('s3', { fresh: true });
    expect(calls()).toBe(2);
  });

  it('pidsFor() returning [] short-circuits to [] with zero execs', async () => {
    const { lister, calls } = countingLister();
    const scanner = new PortScanner({
      ptys: { pidsFor: () => [] } as unknown as PtyManager,
      lister,
    });
    const ports = await scanner.scan('exited-session');
    expect(ports).toEqual([]);
    expect(calls()).toBe(0);
  });

  it('includes sidecar process roots but hides the bridge’s own ports', async () => {
    const ptys = {
      pidsFor: () => [process.pid],
      hiddenPortsFor: () => new Set([7439]),
    } as unknown as PtyManager;
    const scanner = new PortScanner({
      ptys,
      lister: async () => [
        { pid: process.pid, command: 'codex-app-server', port: 7439, address: '127.0.0.1' },
        { pid: process.pid, command: 'preview', port: 4173, address: '127.0.0.1' },
      ],
    });
    expect(await scanner.scan('codex-runtime')).toEqual([
      { pid: process.pid, command: 'preview', port: 4173, address: '127.0.0.1' },
    ]);
  });
});

describe('PortScanner.upstreamHost', () => {
  const ptys = { pidsFor: () => [42] } as unknown as PtyManager;
  const scanner = (platform: NodeJS.Platform, listeners: Listener[]) =>
    new PortScanner({
      ptys,
      platform,
      tree: async () => new Set([42]),
      lister: async () => listeners,
    });
  const listener = (port: number, address: string): Listener => ({
    pid: 42,
    command: 'node',
    port,
    address,
  });

  it('dials ::1 on Windows only for a port listening on IPv6 loopback alone', async () => {
    const listeners = [
      listener(5173, '::1'),
      listener(3000, '::1'),
      listener(3000, '127.0.0.1'),
      listener(8080, '::'),
    ];
    const windows = scanner('win32', listeners);
    expect(await windows.upstreamHost('s', 5173)).toBe('::1');
    expect(await windows.upstreamHost('s', 3000)).toBe('127.0.0.1');
    expect(await windows.upstreamHost('s', 8080)).toBe('127.0.0.1');
    expect(await windows.upstreamHost('s', 9999)).toBe('127.0.0.1');
    expect(await scanner('linux', listeners).upstreamHost('s', 5173)).toBe('127.0.0.1');
  });
});

describe('PortScanner integration (real child process, real platform lister)', () => {
  let child: ChildProcess;
  let childPort: number;
  let scanner: PortScanner;
  const sessionId = 'ports-integration-session';

  beforeAll(async () => {
    child = spawn('node', [
      '-e',
      'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>console.log(s.address().port));',
    ]);
    childPort = await new Promise<number>((resolve, reject) => {
      let buf = '';
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString();
        const match = /(\d+)/.exec(buf);
        if (match) {
          child.stdout?.off('data', onData);
          resolve(Number(match[1]));
        }
      };
      child.stdout?.on('data', onData);
      child.once('error', reject);
    });

    // Cast: PortScanner only calls `pidsFor` on its `ptys` dependency — this
    // stub is a type-compatible subset of the real PtyManager.
    const stubPtys = { pidsFor: () => (child.pid ? [child.pid] : []) } as unknown as PtyManager;
    scanner = new PortScanner({ ptys: stubPtys });
  });

  afterAll(() => {
    child.kill();
  });

  it('scan() finds the port the child process is listening on', async () => {
    const ports = await scanner.scan(sessionId);
    const found = ports.find((p) => p.port === childPort);
    expect(found).toBeDefined();
    expect(found?.pid).toBe(child.pid);
  });

  it('hasPort() is true for the bound port', async () => {
    await expect(scanner.hasPort(sessionId, childPort)).resolves.toBe(true);
  });

  it('hasPort() re-scans once (real listener exec) before returning false for an unused port', async () => {
    const stubPtys = { pidsFor: () => (child.pid ? [child.pid] : []) } as unknown as PtyManager;
    // ttlMs: 0 so both the initial scan and the forced fresh scan inside
    // hasPort() actually exec, making the call count deterministic.
    const freshScanner = new PortScanner({ ptys: stubPtys, ttlMs: 0 });
    const unusedPort = await freePort();

    vi.mocked(execFile).mockClear();
    await expect(freshScanner.hasPort(sessionId, unusedPort)).resolves.toBe(false);
    const listenerCalls = vi
      .mocked(execFile)
      .mock.calls.filter(
        ([cmd]) => cmd === 'lsof' || cmd === 'ss' || /netstat.exe$/i.test(cmd),
      ).length;
    expect(listenerCalls).toBe(2);
  });
});

describe('GET /api/sessions/:id/ports', () => {
  let fx: Fixture;
  let app: Hono;
  let sessionId: string;

  beforeAll(async () => {
    fx = fixture();
    const session = await fx.service.create({
      project_id: fx.ids.project,
      account_id: fx.ids.account,
      title: 'ports route target',
    });
    sessionId = session.id;
    await waitFor(() => fx.service.get(sessionId).status !== 'starting');

    app = new Hono();
    app.onError((err, c) =>
      err instanceof ApiError
        ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
        : c.json({ error: { code: 'internal', message: String(err) } }, 500),
    );
    app.route('/api/sessions', sessionRoutes({ service: fx.service, scanner: fx.scanner }));
  });

  afterAll(async () => {
    await fx.service.kill(sessionId).catch(() => undefined);
  });

  it('404s an unknown session', async () => {
    const res = await app.request('/api/sessions/no-such-session/ports');
    expect(res.status).toBe(404);
  });

  it('returns a schema-valid {ports: []} once the session has no live PTYs', async () => {
    await fx.service.kill(sessionId);
    const res = await app.request(`/api/sessions/${sessionId}/ports`);
    expect(res.status).toBe(200);
    const body = sessionPortsResponseSchema.parse(await res.json());
    expect(body.ports).toEqual([]);
  });
});
