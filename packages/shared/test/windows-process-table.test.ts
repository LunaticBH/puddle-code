import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  isPidAlive,
  listWindowsProcesses,
  WindowsProcessTable,
  type WindowsProcessTableOptions,
} from '../src/node/platform.js';

/**
 * A stand-in for the PowerShell worker that speaks the same protocol: it
 * answers each query line carrying an end marker. The first row's pid counts
 * queries and its ppid is the worker's own pid, so tests can see coalescing,
 * caching and restarts.
 */
const FAKE_WORKER = `
const { existsSync, writeFileSync } = require('node:fs');
const [mode, flag] = process.argv.slice(2);
let queries = 0;
let buffer = '';
const once = () => {
  if (existsSync(flag)) return false;
  writeFileSync(flag, '');
  return true;
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  buffer += data;
  let end;
  while ((end = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    const marker = /'(__PUDDLE_PROCESS_TABLE_END_[0-9a-f]+_\\d+__)'/.exec(line);
    if (marker) answer(marker[1]);
  }
});
function answer(marker) {
  queries++;
  if (mode === 'hang' || (mode === 'hang-once' && once())) return;
  if (mode === 'die' || (mode === 'die-once' && once())) process.exit(3);
  if (mode === 'flood') return void process.stdout.write('x'.repeat(64 * 1024));
  if (mode === 'error') return void process.stdout.write('{"error":"Access denied"}\\n' + marker + '\\n');
  const rows = [
    { p: queries, q: process.pid, n: 'Fake.EXE', c: null, t: 1700000000000 },
    { p: 'not a pid', q: 1, n: 'broken.exe' },
    null,
    { p: 7, q: 1, n: 'node.exe', c: 'node "x y.js"', t: null },
    { p: 8, q: 7, n: 'System Idle Process' },
  ];
  // Split the answer inside the marker, as a pipe may.
  const text = JSON.stringify(rows) + '\\n' + marker + '\\n';
  process.stdout.write(text.slice(0, -12));
  setTimeout(() => process.stdout.write(text.slice(-12)), 5);
}
`;

let fixtures: string;
const tables: WindowsProcessTable[] = [];
beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), 'puddle-process-table-'));
  writeFileSync(join(fixtures, 'worker.cjs'), FAKE_WORKER);
});
afterEach(() => {
  for (const table of tables.splice(0)) table.close();
});
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

function fake(mode: string, options: Omit<WindowsProcessTableOptions, 'worker'> = {}) {
  const flag = join(fixtures, `${mode}-${Math.random().toString(16).slice(2)}`);
  const table = new WindowsProcessTable({
    worker: { file: process.execPath, args: [join(fixtures, 'worker.cjs'), mode, flag] },
    ...options,
  });
  tables.push(table);
  return { table, flag };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Windows process table protocol', () => {
  it('normalises rows and drops malformed ones', async () => {
    const { table } = fake('ok');
    const processes = await table.list();
    expect(processes.map((p) => p.pid)).toEqual([1, 7, 8]);
    expect(processes[0]).toMatchObject({
      name: 'Fake.EXE',
      command: 'fake',
      commandLine: null,
      createdAtMs: 1700000000000,
    });
    expect(processes[1]).toEqual({
      pid: 7,
      ppid: 1,
      name: 'node.exe',
      command: 'node',
      commandLine: 'node "x y.js"',
      createdAtMs: null,
    });
    expect(processes[2]?.command).toBe('system idle process');
    expect(Object.isFrozen(processes[0])).toBe(true);
  });

  it('coalesces concurrent calls and reuses a result briefly', async () => {
    const { table } = fake('ok', { cacheMs: 150 });
    const all = await Promise.all([table.list(), table.list(), table.list()]);
    expect(all.map((processes) => processes[0]?.pid)).toEqual([1, 1, 1]);
    // Each caller owns its array.
    all[0]!.pop();
    expect((await table.list()).length).toBe(3);
    expect((await table.list())[0]?.pid).toBe(1);
    await delay(200);
    expect((await table.list())[0]?.pid).toBe(2);
  });

  it('replaces a worker that times out', async () => {
    const { table } = fake('hang-once', { timeoutMs: 300 });
    await expect(table.list()).rejects.toThrow(/timed out after 300 ms/);
    const [first] = await table.list();
    expect(first?.pid).toBe(1); // a fresh worker's first query
  });

  it('restarts after the worker dies', async () => {
    const { table } = fake('die-once');
    await expect(table.list()).rejects.toThrow(/stopped \(exit code 3\)/);
    expect((await table.list())[0]?.pid).toBe(1);
  });

  it('bounds the answer', async () => {
    const { table } = fake('flood', { maxOutputBytes: 16 * 1024 });
    await expect(table.list()).rejects.toThrow(/exceeded 16384 bytes/);
  });

  it('reports query failures', async () => {
    const { table } = fake('error');
    await expect(table.list()).rejects.toThrow('The process table query failed: Access denied');
  });

  it('stops an idle worker and starts a new one on demand', async () => {
    const { table } = fake('ok', { idleMs: 100, cacheMs: 0 });
    const [first] = await table.list();
    expect(isPidAlive(first!.ppid)).toBe(true);
    for (let i = 0; i < 40 && isPidAlive(first!.ppid); i++) await delay(25);
    expect(isPidAlive(first!.ppid)).toBe(false);
    const [second] = await table.list();
    expect(second!.ppid).not.toBe(first!.ppid);
  });

  it('never holds the event loop open while idle', async () => {
    const before = process.getActiveResourcesInfo().filter((kind) => kind === 'ProcessWrap');
    const { table } = fake('ok');
    const pending = table.list();
    expect(process.getActiveResourcesInfo().filter((kind) => kind === 'ProcessWrap').length).toBe(
      before.length + 1,
    );
    const [first] = await pending;
    expect(isPidAlive(first!.ppid)).toBe(true);
    expect(process.getActiveResourcesInfo().filter((kind) => kind === 'ProcessWrap')).toEqual(
      before,
    );
  });

  it('is refused off Windows', async () => {
    if (process.platform === 'win32') return;
    await expect(listWindowsProcesses()).rejects.toThrow('only available on Windows');
  });
});

describe.skipIf(process.platform !== 'win32')('Windows process table', () => {
  it('finds this process and its parent', async () => {
    const started = performance.now();
    const processes = await listWindowsProcesses();
    const first = performance.now() - started;
    const self = processes.find((p) => p.pid === process.pid);
    expect(self).toBeDefined();
    expect(self!.ppid).toBe(process.ppid);
    expect(self!.command).toBe('node');
    expect(self!.name.toLowerCase()).toBe('node.exe');
    expect(self!.commandLine).toContain('node');
    expect(self!.createdAtMs).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000);
    expect(self!.createdAtMs).toBeLessThanOrEqual(Date.now());
    expect(processes.some((p) => p.pid === process.ppid)).toBe(true);
    expect(processes.find((p) => p.pid === 4)?.command).toBe('system');

    await delay(300);
    const again = performance.now();
    await listWindowsProcesses();
    const warm = performance.now() - again;
    console.info(`process table: first ${first.toFixed(0)} ms, warm ${warm.toFixed(0)} ms`);
    expect(warm).toBeLessThan(5_000);
  });

  it('sees a child it did not start itself, with its command line', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', 'ünïcode ✓'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await delay(300);
      const table = new WindowsProcessTable();
      tables.push(table);
      const entry = (await table.list()).find((p) => p.pid === child.pid);
      expect(entry?.ppid).toBe(process.pid);
      expect(entry?.commandLine).toContain('ünïcode ✓');
    } finally {
      child.kill();
    }
  });
});
