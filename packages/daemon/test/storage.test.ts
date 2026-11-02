import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageMonitor, inspectStorage } from '../src/storage/monitor.js';
import { RuntimePersistence } from '../src/storage/runtime-persistence.js';
import { buildApp } from '../src/http/app.js';
import { LeaseRegistry } from '../src/security/leases.js';
import { openDatabase } from '../src/db/db.js';
import { fixture, waitFor } from './helpers/daemon-fixtures.js';

const full = () => Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
afterEach(() => vi.restoreAllMocks());

describe('storage admission and recovery', () => {
  it('checks actual destination paths afresh and blocks low bytes or inodes', async () => {
    const probe = vi.fn(async (path: string) => ({ path, available_bytes: 2 * 1024 ** 3, available_inodes: 100_000, level: 'ok' as const }));
    const monitor = new StorageMonitor(() => ['/state'], probe);
    await monitor.refresh();
    probe.mockImplementation(async (path) => ({ path, available_bytes: 0, available_inodes: 0, level: 'critical' as 'ok' }));
    await expect(monitor.assertAdmission(['/worktree'])).rejects.toMatchObject({ status: 507, code: 'storage_full' });
    expect(monitor.status().volumes.find((v) => v.path === '/worktree')?.level).toBe('critical');
  });
  it('retains a database failure until a real write probe succeeds', async () => {
    const monitor = new StorageMonitor(() => []);
    const probe = vi.fn(() => { throw full(); });
    monitor.setDatabaseProbe(probe);
    monitor.noteFailure(full());
    await monitor.refresh();
    expect(monitor.status().database_degraded).toBe(true);
    await expect(monitor.assertAdmission([])).rejects.toMatchObject({ status: 507 });
    probe.mockImplementation(() => undefined as never);
    await monitor.refresh();
    expect(monitor.status().database_degraded).toBe(false);
    await expect(monitor.assertAdmission([])).resolves.toBeUndefined();
  });
  it('probes the nearest existing ancestor and reports unavailable paths', async () => {
    expect((await inspectStorage(join(tmpdir(), 'puddle-nonexistent-dir', 'child'))).level).toBe('ok');
  });
  it('does not clear failed snapshots when ordinary logs recover', () => {
    const monitor = new StorageMonitor(() => []);
    monitor.setLogsDegraded(true, 'screens');
    monitor.setLogsDegraded(false, 'logs');
    expect(monitor.status().logs_degraded).toBe(true);
    monitor.setLogsDegraded(false, 'screens');
    expect(monitor.status().logs_degraded).toBe(false);
  });
});

it('returns 507 for a real SQLite page-limit failure without committing a write', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-full-db-'));
  const db = openDatabase(join(home, 'state.db'));
  const authority = new LeaseRegistry();
  try {
    db.exec('CREATE TABLE capacity_test (data BLOB)');
    db.pragma(`max_page_count = ${db.pragma('page_count', { simple: true })}`);
    const app = buildApp({ version: 'test', authority });
    app.post('/capacity-test', () => {
      db.prepare('INSERT INTO capacity_test (data) VALUES (?)').run(Buffer.alloc(1024 * 1024));
      return new Response('saved');
    });
    const response = await app.request('/capacity-test', { method: 'POST' });
    expect(response.status).toBe(507);
    expect(await response.json()).toMatchObject({ error: { code: 'storage_full' } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM capacity_test').get()).toEqual({ n: 0 });
    db.pragma('max_page_count = 100000');
    expect((await app.request('/capacity-test', { method: 'POST' })).status).toBe(200);
  } finally { db.close(); authority.dispose(); rmSync(home, { recursive: true, force: true }); }
});

it('keeps PTY output and exit cleanup working when database writes fail', async () => {
  const f = fixture();
  try {
    const session = await f.service.create({ project_id: f.ids.project, kind: 'terminal' });
    const status = vi.spyOn(f.stores.sessions, 'setStatus').mockImplementation(() => { throw full(); });
    vi.spyOn(f.stores.sessions, 'touchActivity').mockImplementation(() => { throw full(); });
    const output = vi.fn();
    f.ptys.on('data', output);
    f.ptys.write(session.id, 'agent', 'echo storage-survives\r');
    await waitFor(() => output.mock.calls.some(([event]) => event.data.includes('storage-survives')));
    f.ptys.write(session.id, 'agent', 'exit\r');
    await waitFor(() => !f.ptys.has(session.id, 'agent'));
    expect(f.service.get(session.id)).toMatchObject({ status: 'exited', persistence_pending: true });
    status.mockRestore();
    // Exercise the same coalesced recovery independently without waiting 30 seconds.
    const persistence = new RuntimePersistence(f.stores.sessions, f.stores.events);
    const failing = vi.spyOn(f.stores.sessions, 'setStatus').mockImplementation(() => { throw full(); });
    expect(persistence.save(session.id, { status: 'running' })).toBe(false);
    persistence.save(session.id, { status: 'exited', exitCode: 0 });
    failing.mockRestore();
    expect(persistence.retry()).toEqual([session.id]);
    expect(f.stores.sessions.get(session.id).status).toBe('exited');
    expect(f.stores.events.list(session.id).filter((event) => event.type === 'exited')).toHaveLength(1);
  } finally {
    f.service.beginShutdown(); f.ptys.killAll();
    await waitFor(() => f.ptys.liveCount() === 0);
    f.onboarding.dispose(); f.logs.closeAll();
  }
});
