import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listWindowsProcesses,
  system32Path,
  type WindowsProcess,
} from '@puddle/shared/node/platform';
import { LogStore } from '../../src/logs/log-store.js';
import {
  ConptyHelper,
  type ConptyConsole,
  type ConsoleInspector,
} from '../../src/pty/conpty-jobs.js';
import { PtyManager } from '../../src/pty/pty-manager.js';
import {
  ptyRootsFile,
  readPtyRoots,
  writePtyRoots,
  type PtyRootRecord,
} from '../../src/pty/pty-roots.js';
import { reapWindowsDaemon } from '../../src/supervision/reap-daemon.js';
import { stopPtysAfterFile } from '../helpers/process-guard.js';
import { marked, stopMarked, survivors, waitUntil } from '../helpers/process-trees.js';

/**
 * What the Windows supervisor stops after its daemon exits, against
 * stand-in process tables and a stand-in ConPTY helper (runs on any OS;
 * windows-daemon-teardown.test.ts runs it against a real daemon, and the
 * last test here against real processes): what is still attached to one of
 * its PTYs' consoles, and never a GUI programme, what one started, or a
 * process that left the console (detached, or in a console of its own).
 */

interface Process extends WindowsProcess {
  gui: boolean;
  /** Started by a GUI programme below its PTY's root (as the helper's scan says). */
  guiStarted: boolean;
  /** The console host it names: 0 for none (detached). */
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
  guiStarted: false,
  consoleHost: 0,
  ...more,
});
/** A PTY's headless console host. */
const conhost = (pid: number, ppid: number, createdAtMs: number) =>
  entry(pid, ppid, createdAtMs, {
    name: 'conhost.exe',
    command: 'conhost',
    commandLine: '\\\\?\\C:\\WINDOWS\\system32\\conhost.exe --headless --width 120 --height 32',
  });
/** The console host of a console of its own (Start-Process, a hidden child): its owner's child. */
const ownConsole = (pid: number, owner: number, createdAtMs: number) =>
  entry(pid, owner, createdAtMs, {
    name: 'conhost.exe',
    command: 'conhost',
    commandLine: '\\??\\C:\\WINDOWS\\system32\\conhost.exe 0xffffffff -ForceV1',
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
  const spared = (p: Process) => p.gui || p.guiStarted;
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
        guiStarted: p.guiStarted,
        consoleHost: p.consoleHost,
        listed: false,
      })),
    }),
    terminate: async (keys) => {
      let count = 0;
      for (const each of keys) {
        const target =
          each === 'host' ? host : (members().find((p) => key(p) === each && !spared(p)) ?? null);
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
      // As the helper's scan: what names the host and was created after it.
      return hold(
        () => processes.filter((p) => p.consoleHost === pid && p.createdAtMs! >= createdAtMs),
        host,
      );
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
    processes: async () =>
      processes.map(({ gui: _gui, guiStarted: _started, consoleHost: _host, ...p }) => p),
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
  const { host: _host, ...untold } = root;

  it('ends what is still attached to a recorded console, never a GUI programme, then its host', async () => {
    const rootsFile = home([root]);
    const w = world([
      conhost(30, 100, 2005),
      entry(11, 10, 2100, { consoleHost: 30 }), // still attached, in its CTRL_CLOSE handler
      entry(12, 10, 2200, { consoleHost: 30, gui: true }), // a GUI programme attached to it
      entry(16, 12, 2250, { consoleHost: 30, guiStarted: true }), // and what it started there
      entry(13, 10, 2300, { consoleHost: 50 }), // left the console: a console of its own
      ownConsole(50, 13, 2301),
      entry(14, 10, 2400), // detached
      // Left naming pid 30 when the host it ran in then (an earlier
      // process) was terminated: it was created before this host.
      entry(15, 7, 1500, { consoleHost: 30 }),
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

  it('for a console whose host has gone, or is another process now, ends below its root what names that host', async () => {
    for (const host of [[], [conhost(30, 100, 9000)], [conhost(30, 7, 2005)]]) {
      const w = world([
        ...host,
        entry(11, 10, 2100, { consoleHost: 51 }), // a console of its own
        ownConsole(51, 11, 2101),
        entry(12, 10, 2200), // detached
        // Attached to the PTY's console, whose host has gone.
        entry(13, 10, 2300, { consoleHost: 30 }),
        // A Start-Process (or hidden) child whose own console's host was
        // terminated: it names another host, so it left the PTY's console.
        entry(14, 10, 2400, { consoleHost: 77 }),
        entry(15, 14, 2500, { consoleHost: 77 }), // and its child, in that console
      ]);
      await reapWindowsDaemon(daemon, 5000, {
        processes: w.processes,
        rootsFile: home([root]),
        consoles: w.inspector,
      });
      expect(w.terminated).toEqual([13]);
    }
  });

  it('spares what may be attached to a later holder of a recorded host’s pid', async () => {
    const w = world([
      // The PTY's host (30, created at 2005) has gone; another console's host took pid 30 at 2600.
      ownConsole(30, 7, 2600),
      entry(13, 10, 2300, { consoleHost: 30 }), // created before that: the PTY's console's
      entry(16, 10, 2700, { consoleHost: 30 }), // created after: it may be that console's
      entry(17, 10, 2003, { consoleHost: 30 }), // older than the PTY's host: not its
    ]);
    await reapWindowsDaemon(daemon, 5000, {
      processes: w.processes,
      rootsFile: home([root]),
      consoles: w.inspector,
    });
    expect(w.terminated).toEqual([13]);
  });

  it('for a console never told apart, ends below its root only what is attached to a PTY console', async () => {
    const w = world([
      conhost(30, 100, 2005), // the root's console's host, never told apart
      entry(11, 10, 2100, { consoleHost: 50 }), // a hidden child: a console of its own
      ownConsole(50, 11, 2101),
      entry(12, 11, 2200, { consoleHost: 50 }), // and its child, in that console
      entry(13, 10, 2300, { gui: true }), // a GUI programme
      entry(14, 13, 2400, { consoleHost: 30 }), // and what it started, though in the PTY's console
      entry(15, 10, 2500), // detached
      entry(16, 15, 2600, { consoleHost: 52 }), // and what it started
      ownConsole(52, 16, 2601),
      entry(17, 10, 2700, { consoleHost: 30 }), // attached to the PTY's console
      entry(19, 17, 2800, { consoleHost: 30 }), // and its child
      entry(20, 10, 2900, { consoleHost: 77 }), // in a console that has gone
      entry(21, 10, 3000, { consoleHost: 53 }), // naming a host created after it (its pid reused)
      ownConsole(53, 7, 3500),
      entry(18, 17, 6000, { consoleHost: 30 }), // started after the daemon's exit
    ]);
    const count = await reapWindowsDaemon(daemon, 5000, {
      processes: w.processes,
      rootsFile: home([{ ...untold, exitedAtMs: 4000 }]),
      consoles: w.inspector,
    });
    expect(w.terminated.sort((a, b) => a - b)).toEqual([17, 19, 20, 21]);
    expect(count).toBe(4);
  });

  it('never ends a Start-Process server below a PowerShell root whose host was never recorded', async () => {
    // The reviewer's case: PowerShell, then Start-Process -WindowStyle Hidden
    // node server.js; the daemon crashed before the host was recorded, and
    // the console's close ended PowerShell.
    const w = world([entry(40, 10, 2500, { consoleHost: 41 }), ownConsole(41, 40, 2501)]);
    await reapWindowsDaemon(daemon, 5000, {
      processes: w.processes,
      rootsFile: home([{ ...untold, exitedAtMs: 4500 }]),
      consoles: w.inspector,
    });
    expect(w.terminated).toEqual([]);
  });

  it('leaves the children of a later holder of a dead root’s pid alone', async () => {
    const w = world([
      conhost(30, 100, 2005),
      entry(11, 10, 2100, { consoleHost: 30 }), // the root's
      // The root exited at 3000 (its PTY's teardown still ran); a process
      // that took pid 10 then started this before the daemon died.
      entry(18, 10, 3500, { consoleHost: 30 }),
    ]);
    await reapWindowsDaemon(daemon, 5000, {
      processes: w.processes,
      rootsFile: home([{ ...untold, exitedAtMs: 3000 }]),
      consoles: w.inspector,
    });
    expect(w.terminated).toEqual([11]);
  });

  it('ends nothing the daemon’s own children started', async () => {
    const w = world([
      conhost(30, 100, 2005),
      entry(10, 100, 2008, { consoleHost: 30 }), // the PTY root, ended through its console
      // A process the daemon started (Node ends those with it), its console,
      // and what it started: no PTY console's.
      entry(20, 100, 3000, { consoleHost: 54 }),
      ownConsole(54, 20, 3001),
      entry(22, 20, 3200, { consoleHost: 54 }),
      entry(23, 20, 3300), // detached
    ]);
    await reapWindowsDaemon(daemon, 5000, {
      processes: w.processes,
      rootsFile: home([root]),
      consoles: w.inspector,
    });
    expect(w.terminated).toEqual([10, 30]);
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

  it('stops nothing for a daemon that recorded no PTY', async () => {
    const w = world([entry(13, 100, 3000, { consoleHost: 30 }), conhost(30, 100, 2005)]);
    expect(
      await reapWindowsDaemon({ pid: 100 }, 5000, {
        processes: w.processes,
        rootsFile: home([]),
        consoles: w.inspector,
      }),
    ).toBe(0);
  });
});

/**
 * The same against real processes: a PowerShell PTY (this process standing
 * in for a daemon that died before its console host was recorded) that has
 * started ping in its console and a server in a console of its own.
 */
describe.skipIf(process.platform !== 'win32')('reapWindowsDaemon on Windows', () => {
  const markers: string[] = [];
  afterEach(async () => {
    for (const marker of markers.splice(0)) await stopMarked(marker);
  });

  it('ends what is attached to the PTY console below an untold root, never a Start-Process server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-reap-real-'));
    markers.push(dir);
    const rootsFile = ptyRootsFile(dir);
    const startedAtMs = Date.now();
    const logs = new LogStore(mkdtempSync(join(tmpdir(), 'puddle-logs-')), 64 * 1024);
    // No helper: its console host is never told apart.
    const ptys = new PtyManager(logs, undefined, undefined, undefined, { rootsFile, jobs: null });
    stopPtysAfterFile(ptys);
    let output = '';
    ptys.on('data', (e: { data: string }) => (output += e.data));
    const shell = system32Path(join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
    ptys.spawn('r', 'agent', shell, ['-NoLogo', '-NoProfile'], { cwd: dir });
    await waitUntil(() => /PS .*>/.test(output), 30_000, 'a prompt');
    const root = ptys.pidFor('r', 'agent')!;
    const node = process.execPath;
    // (Windows PowerShell's -ArgumentList joins arguments unquoted: no spaces.)
    ptys.write(
      'r',
      'agent',
      `Start-Process -WindowStyle Hidden '${node}' -ArgumentList '-e','setInterval(()=>{},1e9)','${dir}:server'; ` +
        `& '${node}' -e 'setInterval(()=>{},1e9)' '${dir}:attached'\r`,
    );
    let server: WindowsProcess[] = [];
    let attached: WindowsProcess[] = [];
    await waitUntil(
      async () => {
        const named = (await marked(dir)).filter((p) => p.name.toLowerCase() === 'node.exe');
        server = named.filter((p) => p.commandLine!.includes(':server'));
        attached = named.filter((p) => p.commandLine!.includes(':attached'));
        return server.length === 1 && attached.length === 1;
      },
      30_000,
      'the server and the attached child',
    );
    // Both PowerShell's children, its server in a console of its own.
    expect([server[0]!.ppid, attached[0]!.ppid]).toEqual([root, root]);
    expect(readPtyRoots(rootsFile, process.pid)![0]!.host).toBeUndefined();
    const helper = new ConptyHelper();
    try {
      const count = await reapWindowsDaemon({ pid: process.pid, startedAtMs }, Date.now(), {
        processes: listWindowsProcesses,
        rootsFile,
        consoles: helper,
      });
      // The root and its attached child; never the server.
      expect(count).toBe(2);
      expect(await survivors(attached)).toEqual([]);
      expect(await survivors(server)).toHaveLength(1);
    } finally {
      if (helper.pid !== undefined) process.kill(helper.pid);
    }
  });
});
