import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkCockpit,
  cockpitLogPath,
  cockpitRecordPath,
  isRecordedProcess,
  listCockpitRecords,
  readCockpitRecord,
  removeCockpitRecord,
  writeCockpitRecord,
  type CockpitRecord,
} from '../../src/lib/registry.js';

const record = (over: Partial<CockpitRecord>): CockpitRecord => ({
  target: 'local',
  pid: process.pid,
  status: 'ready',
  startedAt: new Date().toISOString(),
  cliVersion: 'test',
  ...over,
});

describe('cockpit registry', () => {
  let nonceServer: Server;
  let origin: string;

  beforeAll(async () => {
    process.env.PUDDLE_HOME = mkdtempSync(join(tmpdir(), 'puddle-registry-'));
    // A stand-in UI server that echoes the cockpit nonce header.
    nonceServer = createServer((_req, res) => {
      res.setHeader('x-puddle-cockpit', 'the-nonce');
      res.end();
    });
    await new Promise<void>((r) => nonceServer.listen(0, '127.0.0.1', r));
    const address = nonceServer.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise((r) => nonceServer.close(r));
    delete process.env.PUDDLE_HOME;
  });

  it('round-trips records and lists them sorted by target', () => {
    writeCockpitRecord(record({ target: 'local' }));
    writeCockpitRecord(record({ target: 'bob@devbox', status: 'starting' }));
    expect(readCockpitRecord('local')?.status).toBe('ready');
    expect(listCockpitRecords().map((r) => r.target)).toEqual(['bob@devbox', 'local']);
    removeCockpitRecord('bob@devbox');
    expect(readCockpitRecord('bob@devbox')).toBeNull();
    removeCockpitRecord('local');
  });

  it('keeps registry filenames filesystem-safe however hostile the target', () => {
    const path = cockpitRecordPath('user@host:22/../../evil');
    // The whole target collapses into ONE filename inside the cockpits dir —
    // no separator survives, so no traversal is possible.
    expect(dirname(path)).toBe(join(process.env.PUDDLE_HOME ?? '', 'cockpits'));
    expect(path.endsWith('.json')).toBe(true);
    expect(basename(cockpitLogPath('a b/c'))).not.toContain(' ');
  });

  it('verifies liveness by pid AND nonce, never reachability alone', async () => {
    // Dead pid → dead (the only prunable state), whatever the record claims.
    expect(await checkCockpit(record({ pid: 2 ** 30, origin, nonce: 'the-nonce' }))).toBe('dead');
    // Live pid but the origin answers with a different identity → unverified,
    // never dead: the record is the only handle to a live process.
    expect(await checkCockpit(record({ origin, nonce: 'someone-else' }))).toBe('unverified');
    // Live pid, no listener at all → unverified.
    expect(await checkCockpit(record({ origin: 'http://127.0.0.1:1', nonce: 'x' }))).toBe(
      'unverified',
    );
    // Live pid + matching nonce → running.
    expect(await checkCockpit(record({ origin, nonce: 'the-nonce' }))).toBe('running');
    // Still bootstrapping → starting (no origin to verify yet).
    expect(await checkCockpit(record({ status: 'starting' }))).toBe('starting');
  });

  it('on Windows, trusts a live pid only for a process no younger than its record', async () => {
    const startedAt = '2026-11-03T12:00:00.000Z';
    const table = (createdAtMs: number | null) => async () => [
      { pid: 77, ppid: 1, name: 'node.exe', command: 'node', commandLine: null, createdAtMs },
    ];
    const at = Date.parse(startedAt);
    expect(await isRecordedProcess({ pid: 77, startedAt }, 'win32', table(at - 800))).toBe(true);
    // Recycled: the pid now names a process started after the cockpit recorded itself.
    expect(await isRecordedProcess({ pid: 77, startedAt }, 'win32', table(at + 60_000))).toBe(
      false,
    );
    expect(await isRecordedProcess({ pid: 78, startedAt }, 'win32', table(at))).toBe(false);
    expect(await isRecordedProcess({ pid: 77, startedAt }, 'win32', table(null))).toBe(false);
    // Unknowable without the process table; POSIX keeps trusting the pid.
    const broken = () => Promise.reject(new Error('PowerShell blocked'));
    expect(await isRecordedProcess({ pid: 77, startedAt }, 'win32', broken)).toBeNull();
    expect(await isRecordedProcess({ pid: 77, startedAt }, 'linux', broken)).toBe(true);
  });
});
