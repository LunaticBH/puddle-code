import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sessionPortsResponseSchema } from '@puddle/shared';
import { ApiError } from '../../src/http/errors.js';
import { sessionRoutes } from '../../src/http/routes/sessions.js';
import { descendantsOf, parsePsOutput } from '../../src/ports/process-tree.js';
import {
  parseLsofOutput,
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

    const result = await descendantsOf([100]);
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
      .mock.calls.filter(([cmd]) => cmd === 'lsof' || cmd === 'ss').length;
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
