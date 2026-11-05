import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WindowsProcess } from '@puddle/shared/node/platform';
import type { ConptyConsole, ConsoleInspector } from '../../src/pty/conpty-jobs.js';
import {
  ptyRootsFile,
  readPtyRoots,
  writePtyRoots,
  type PtyRootRecord,
} from '../../src/pty/pty-roots.js';
import { reapWindowsDaemon } from '../../src/supervision/reap-daemon.js';

/**
 * What the Windows supervisor stops after its daemon exits, against
 * stand-in process tables and a stand-in ConPTY helper (runs on any OS;
 * windows-daemon-teardown.test.ts runs it against a real daemon): what is
 * still attached to a PTY's console, and never a GUI programme or a process
 * that left the console.
 */

interface Process extends WindowsProcess {
  gui: boolean;
  /** The console host it is attached to: 0 for none (detached). */
  consoleHost: number;
}

const entry = (
  pid: number,
  ppid: number,
  createdAtMs: number,
  more: Partial<Process> = {},
): Process => ({
  pid,
  ppid,
  name: 'node.exe',
  command: 'node',
  commandLine: `node.exe ${pid}`,
  createdAtMs,
  gui: false,
  consoleHost: 50, // a console of its own, by default
  ...more,
});
const conhost = (pid: number, ppid: number, createdAtMs: number) =>
  entry(pid, ppid, createdAtMs, {
    name: 'conhost.exe',
    command: 'conhost',
    commandLine: '\\\\?\\C:\\WINDOWS\\system32\\conhost.exe --headless --width 120 --height 32',
    consoleHost: 0,
  });

/** A table and a helper over the same processes, recording what it ends. */
function world(initial: Process[]) {
  let processes = [...initial];
  const terminated: number[] = [];
  const end = (pid: number) => {
    terminated.push(pid);
    processes = processes.filter((p) => p.pid !== pid);
  };
  const find = (pid: number, createdAtMs: number) =>
    processes.find((p) => p.pid === pid && p.createdAtMs === createdAtMs);
  const key = (p: Process) => `${p.pid}@${p.createdAtMs}`;
  const hold = (members: () => Process[], host: Process | null): ConptyConsole => ({
    rootCreatedAtMs: null,
    host: host ? { pid: host.pid, createdAtMs: host.createdAtMs! } : null,
    alive: async () => ({ root: false, host: host !== null && processes.includes(host) }),
    scan: async () => ({
      rootAlive: false,
      hostAlive: host !== null && processes.includes(host),
      members: members().map((p) => ({
        pid: p.pid,
        createdAtMs: p.createdAtMs!,
        key: key(p),
        gui: p.gui,
        guiStarted: false,
        consoleHost: p.consoleHost,
        listed: false,
      })),
    }),
    terminate: async (keys) => {
      let count = 0;
      for (const each of keys) {
        const target =
          each === 'host' ? host : (members().find((p) => key(p) === each && !p.gui) ?? null);
        if (target && processes.includes(target)) {
          end(target.pid);
          count++;
        }
      }
      return count;
    },
    release: () => {},
  });
  const inspector: ConsoleInspector = {
    ready: async () => true,
    adopt: async ({ pid, createdAtMs, parentPid }) => {
      const host = find(pid, createdAtMs);
      if (!host || host.ppid !== parentPid || host.name !== 'conhost.exe') return null;
      return hold(() => processes.filter((p) => p.consoleHost === pid), host);
    },
    classify: async (list) => {
      const held = list.flatMap(({ pid, createdAtMs }) => find(pid, createdAtMs) ?? []);
      return {
        console: hold(() => held.filter((p) => processes.includes(p)), null),
        processes: held.map((p) => ({
          pid: p.pid,
          createdAtMs: p.createdAtMs!,
          key: key(p),
          gui: p.gui,
          consoleHost: p.consoleHost,
        })),
      };
    },
  };
  return {
    terminated,
    inspector,
    processes: async () => processes.map(({ gui: _gui, consoleHost: _host, ...p }) => p),
    alive: (pid: number) => processes.some((p) => p.pid === pid),
  };
}

function home(roots: PtyRootRecord[], daemon = 100) {
  const rootsFile = ptyRootsFile(mkdtempSync(join(tmpdir(), 'puddle-reap-')));
  writePtyRoots(rootsFile, daemon, roots);
  return rootsFile;
}

describe('reapWindowsDaemon', () => {
  // The daemon (pid 100) ran from 1000 to 5000; its PTY root 10 was spawned at 2000,
  // in the console host 30.
  const daemon = { pid: 100, startedAtMs: 1000 };
  const root: PtyRootRecord = {
    pid: 10,
    startedAtMs: 2000,
    spawnedAtMs: 2010,
    host: { pid: 30, createdAtMs: 2005 },
  };

  it('ends what is still attached to a recorded console, never a GUI programme, then its host', async () => {
    const rootsFile = home([root]);
    const w = world([
      conhost(30, 100, 2005),
      entry(11, 10, 2100, { consoleHost: 30 }), // still attached, in its CTRL_CLOSE handler
      entry(12, 10, 2200, { consoleHost: 30, gui: true }), // a GUI programme attached to it
      entry(13, 10, 2300), // left the console: a console of its own
      entry(14, 10, 2400, { consoleHost: 0 }), // detached
    ]);
    const count = await reapWindowsDaemon(daemon, 5000, {
      processes: w.processes,
      rootsFile,
      consoles: w.inspector,
    });
    expect(w.terminated).toEqual([11, 30]);
    expect(count).toBe(2);
    expect(existsSync(rootsFile)).toBe(false);
  });

  it('ends nothing of a console whose host has gone, or is another process now', async () => {
    for (const host of [[], [conhost(30, 100, 9000)], [conhost(30, 7, 2005)]]) {
      const w = world([...host, entry(11, 10, 2100), entry(12, 10, 2200, { consoleHost: 0 })]);
      await reapWindowsDaemon(daemon, 5000, {
        processes: w.processes,
        rootsFile: home([root]),
        consoles: w.inspector,
      });
      // Its close took what was attached; what is left had left it.
      expect(w.terminated).toEqual([]);
    }
  });

  it('for a console never told apart, ends the console programmes below its root only', async () => {
    const { host: _host, ...untold } = root;
    const w = world([
      entry(11, 10, 2100), // a hidden child: a console of its own
      entry(12, 11, 2200), // and its child
      entry(13, 10, 2300, { gui: true }), // a GUI programme
      entry(14, 13, 2400), // and what it started
      entry(15, 10, 2500, { consoleHost: 0 }), // detached
      entry(16, 15, 2600), // and what it started
      entry(17, 11, 6000), // started after the daemon's exit
    ]);
    const count = await reapWindowsDaemon(daemon, 5000, {
      processes: w.processes,
      rootsFile: home([{ ...untold, exitedAtMs: 4000 }]),
      consoles: w.inspector,
    });
    expect(w.terminated).toEqual([11, 12]);
    expect(count).toBe(2);
  });

  it('leaves the children of a later holder of a dead root’s pid alone', async () => {
    const { host: _host, ...untold } = root;
    const w = world([
      entry(11, 10, 2100), // the root's
      // The root exited at 3000 (its PTY's teardown still ran); a process
      // that took pid 10 then started this before the daemon died.
      entry(18, 10, 3500),
    ]);
    await reapWindowsDaemon(daemon, 5000, {
      processes: w.processes,
      rootsFile: home([{ ...untold, exitedAtMs: 3000 }]),
      consoles: w.inspector,
    });
    expect(w.terminated).toEqual([11]);
  });

  it('ends the daemon’s own console children, not its PTYs’ roots and hosts, nor what left', async () => {
    const w = world([
      conhost(30, 100, 2005),
      entry(10, 100, 2005, { consoleHost: 30 }), // the PTY root, ended through its console
      entry(20, 100, 3000), // a headless agent the daemon started
      entry(21, 20, 3100, { gui: true }), // a browser it opened
      entry(22, 21, 3200), // and the browser's child
      entry(23, 20, 3300, { consoleHost: 0 }), // a detached server
      entry(24, 100, 500), // an earlier holder of the daemon's pid left this
    ]);
    await reapWindowsDaemon(daemon, 5000, {
      processes: w.processes,
      rootsFile: home([root]),
      consoles: w.inspector,
    });
    expect(w.terminated).toEqual([10, 30, 20]);
  });

  it('ends nothing without a helper to tell a console programme from a GUI one', async () => {
    const rootsFile = home([root]);
    const w = world([conhost(30, 100, 2005), entry(11, 10, 2100, { consoleHost: 30 })]);
    const unavailable: ConsoleInspector = { ...w.inspector, ready: async () => false };
    for (const consoles of [null, unavailable]) {
      expect(
        await reapWindowsDaemon(daemon, 5000, { processes: w.processes, rootsFile, consoles }),
      ).toBe(0);
    }
    expect(w.terminated).toEqual([]);
    expect(existsSync(rootsFile)).toBe(false);
  });

  it('leaves another daemon’s record alone', async () => {
    const rootsFile = home([root], 200);
    const w = world([conhost(30, 100, 2005), entry(11, 10, 2100, { consoleHost: 30 })]);
    expect(
      await reapWindowsDaemon(daemon, 5000, {
        processes: w.processes,
        rootsFile,
        consoles: w.inspector,
      }),
    ).toBe(0);
    expect(w.terminated).toEqual([]);
    expect(readPtyRoots(rootsFile, 200)).toHaveLength(1);
  });

  it('stops nothing below a daemon it cannot date', async () => {
    const w = world([entry(13, 100, 3000)]);
    expect(
      await reapWindowsDaemon({ pid: 100 }, 5000, {
        processes: w.processes,
        rootsFile: home([]),
        consoles: w.inspector,
      }),
    ).toBe(0);
  });
});
