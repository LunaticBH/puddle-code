import { describe, expect, it } from 'vitest';
import type { WindowsProcess } from '@puddle/shared/node/platform';
import {
  reapConptyTree,
  snapshotConptyTree,
  type ConptyRoot,
  type ConptyTeardownDeps,
} from '../../src/pty/conpty-teardown.js';

/**
 * What a ConPTY root leaves behind, against stand-in process tables, so the
 * Windows teardown is exercised on any OS (the real one is in
 * windows-pty-teardown.test.ts).
 */

const HOST = 4000; // the daemon: every ConPTY host is its child
const entry = (
  pid: number,
  ppid: number,
  createdAtMs: number,
  name = 'node.exe',
  commandLine = `${name} ${pid}`,
): WindowsProcess => ({
  pid,
  ppid,
  name,
  command: name.replace(/\.exe$/i, '').toLowerCase(),
  commandLine,
  createdAtMs,
});
const conhost = (pid: number, createdAtMs: number) =>
  entry(
    pid,
    HOST,
    createdAtMs,
    'conhost.exe',
    '\\\\?\\C:\\WINDOWS\\system32\\conhost.exe --headless --width 120 --height 32 --signal 0x5f0 --server 0x79c',
  );

function world(initial: WindowsProcess[], alive: (pid: number) => boolean = () => false) {
  let processes = [...initial];
  let clock = 10_000;
  const terminated: number[] = [];
  const deps: ConptyTeardownDeps = {
    processes: async () => [...processes],
    terminate: (pid) => {
      terminated.push(pid);
      processes = processes.filter((p) => p.pid !== pid);
    },
    isAlive: alive,
    hostPid: HOST,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return {
    deps,
    terminated,
    set: (next: WindowsProcess[]) => (processes = next),
    get clock() {
      return clock;
    },
  };
}

// The PTY was spawned between 1000 and 1010; its root (pid 10) was created at 1020.
const root: ConptyRoot = { pid: 10, startedAtMs: 1000, spawnedAtMs: 1010, exited: true };

describe('reapConptyTree', () => {
  it('stops what an exited root left running, then its own ConPTY host', async () => {
    const w = world([
      conhost(500, 1005), // this PTY's host
      conhost(501, 3000), // another PTY's, spawned later
      entry(11, 10, 1100), // a detached child of the root
      entry(12, 11, 1200), // and its child
      entry(30, 10, 400), // an earlier holder of pid 10 left this
      entry(40, 1, 50), // unrelated
    ]);
    const stopped = await reapConptyTree(root, w.deps);
    expect(w.terminated).toEqual([11, 12, 500]);
    expect(stopped.map((p) => p.pid)).toEqual([11, 12, 500]);
  });

  it('leaves a later holder of the root’s pid alone', async () => {
    const w = world([entry(10, 1, 9000), entry(13, 10, 9100), entry(11, 10, 1100)]);
    await reapConptyTree(root, w.deps);
    expect(w.terminated).toEqual([11]);
  });

  it('stops no ConPTY host it cannot tell from another PTY’s', async () => {
    const w = world([conhost(500, 1004), conhost(502, 1008)]);
    await reapConptyTree(root, w.deps);
    expect(w.terminated).toEqual([]);
  });

  it('gives a root still running when its console closed time to exit on its own', async () => {
    let running = true;
    const w = world([entry(10, HOST, 1020), entry(11, 10, 1100)], (pid) => pid === 10 && running);
    // It exits 200 ms into its grace period, leaving its child.
    const sleep = w.deps.sleep;
    w.deps.sleep = async (ms) => {
      await sleep(ms);
      if (w.clock >= 10_200 && running) {
        running = false;
        w.set([entry(11, 10, 1100)]);
      }
    };
    await reapConptyTree({ ...root, exited: false }, w.deps);
    expect(w.clock).toBe(10_200);
    expect(w.terminated).toEqual([11]);
  });

  it('stops a root that outstays its grace period, with its tree', async () => {
    const w = world([entry(10, HOST, 1020), entry(11, 10, 1100)], (pid) => pid === 10);
    w.deps.graceMs = 500;
    await reapConptyTree({ ...root, exited: false }, w.deps);
    expect(w.clock).toBe(10_500);
    expect(w.terminated).toEqual([10, 11]);
  });

  it('stops members read before the console closed, though their parent exited since', async () => {
    const w = world([entry(12, 11, 1200), entry(13, 12, 1300)]);
    const known = [entry(10, HOST, 1020), entry(11, 10, 1100), entry(12, 11, 1200)];
    await reapConptyTree(root, w.deps, known);
    expect(w.terminated).toEqual([12, 13]);
  });
});

describe('snapshotConptyTree', () => {
  it('reads the running root’s tree, and nothing for a pid another process took', async () => {
    const tree = [entry(10, HOST, 1020), entry(11, 10, 1100), entry(40, 1, 50)];
    expect(
      (await snapshotConptyTree(root, { processes: async () => tree })).map((p) => p.pid),
    ).toEqual([10, 11]);
    // Created long after node-pty would have started the root.
    const later = [entry(10, HOST, 60_000), entry(11, 10, 60_100)];
    expect(await snapshotConptyTree(root, { processes: async () => later })).toEqual([]);
  });
});
