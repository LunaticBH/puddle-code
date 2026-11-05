import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { WindowsProcess } from '@puddle/shared/node/platform';
import { stopProcess } from '../../src/agents/codex/lifecycle.js';
import type { ClassifiedProcess, ConptyConsole } from '../../src/pty/conpty-jobs.js';
import { role, stillRunning, stopMarked, survivors } from '../helpers/process-trees.js';
import { sparedTreeMembers, writeSparedTree } from '../helpers/spared-trees.js';

/**
 * Ending a Codex app-server on Windows (docs/windows.md, decision 8): the
 * launcher the daemon started, by its handle, and what is attached to its
 * console, by the ConPTY helper's holds; never a GUI programme or what one
 * started, a detached process or one in a console of its own, nor a process
 * the process table cannot vouch for. Tables and the helper are stand-ins
 * first, so this runs on any OS; the last block ends real processes.
 */

const entry = (
  pid: number,
  ppid: number,
  createdAtMs: number,
  name = 'node.exe',
): WindowsProcess => ({
  pid,
  ppid,
  name,
  command: name.replace(/\.exe$/i, '').toLowerCase(),
  commandLine: `${name} ${pid}`,
  createdAtMs,
});

/** A stand-in for the app-server's ChildProcess: what it was asked. */
function launcher(pid: number) {
  const signals: Array<string | undefined> = [];
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    killed: false,
    kill: (signal?: string) => {
      signals.push(signal);
      return true;
    },
  });
  return { child: child as unknown as ChildProcess, signals };
}

/**
 * A process table and a ConPTY helper over it: `attached` names each
 * process's console host (0 for none), `gui` the GUI programmes. The helper
 * holds only processes still running as created then; ending one removes it.
 */
function world(
  initial: WindowsProcess[],
  info: { attached: Record<number, number>; gui?: number[] },
) {
  let processes = [...initial];
  const ended: string[] = [];
  const terminated: number[] = [];
  const classified: string[][] = [];
  let released = 0;
  const hooks: Array<(key: string) => void> = [];
  const remove = (pid: number, createdAtMs?: number) => {
    processes = processes.filter(
      (p) => !(p.pid === pid && (createdAtMs === undefined || p.createdAtMs === createdAtMs)),
    );
  };
  const console = (): ConptyConsole => ({
    rootCreatedAtMs: null,
    host: null,
    alive: async () => null,
    scan: async () => null,
    terminate: async (keys) => {
      for (const key of keys) {
        ended.push(key);
        const [pid, created] = key.split('@').map(Number);
        remove(pid!, created);
        for (const hook of hooks) hook(key);
      }
      return keys.length;
    },
    release: () => {
      released++;
    },
  });
  return {
    ended,
    terminated,
    classified,
    released: () => released,
    add: (...more: WindowsProcess[]) => processes.push(...more),
    onEnd: (hook: (key: string) => void) => hooks.push(hook),
    processes: async () => [...processes],
    terminate: (pid: number) => {
      terminated.push(pid);
      remove(pid);
    },
    inspector: {
      classify: async (list: readonly { pid: number; createdAtMs: number }[]) => {
        classified.push(list.map((p) => `${p.pid}@${p.createdAtMs}`));
        const held: ClassifiedProcess[] = list
          .filter((p) => processes.some((e) => e.pid === p.pid && e.createdAtMs === p.createdAtMs))
          .map((p) => ({
            ...p,
            key: `${p.pid}@${p.createdAtMs}`,
            gui: info.gui?.includes(p.pid) ?? false,
            consoleHost: info.attached[p.pid] ?? 0,
          }));
        return { console: console(), processes: held };
      },
    },
  };
}

/** The launcher (100) and its console's host (101), started between 995 and 1005. */
const L = entry(100, 50, 1000);
const H = entry(101, 100, 1001, 'conhost.exe');
/** The native server, and what it runs. */
const S = entry(102, 100, 1010, 'codex.exe');
const C = entry(103, 102, 1100, 'pwsh.exe'); // a command on the console
const G = entry(104, 102, 1200, 'gui.exe'); // a GUI programme that attached to it
const GC = entry(105, 104, 1300); // a console programme that one started there
const D = entry(106, 102, 1400); // a detached process
const O = entry(107, 999, 1500); // on the console, its parent gone
const U = entry(200, 1, 1600); // another console's orphan
const table = [L, H, S, C, G, GC, D, O, U];
const attached = { 100: 101, 102: 101, 103: 101, 104: 101, 105: 101, 107: 101, 200: 300 };
const server = (child: ChildProcess) => ({ child, startedAtMs: 995, spawnedAtMs: 1005 });
const key = (e: WindowsProcess) => `${e.pid}@${e.createdAtMs}`;

describe('stopping the Codex app-server on Windows', () => {
  it('ends the launcher by its handle and what is attached to its console, nothing else', async () => {
    const w = world(table, { attached, gui: [104] });
    const { child, signals } = launcher(100);
    await stopProcess(server(child), 'win32', {
      processes: w.processes,
      inspector: w.inspector,
      terminate: w.terminate,
      subsystem: async () => 3,
      now: () => 5000,
    });
    expect(signals).toEqual([undefined]);
    expect(w.ended).toEqual([key(S), key(C), key(O)]);
    expect(w.terminated).toEqual([]);
    expect(w.released()).toBe(w.classified.length);
  });

  it('ends what a member started meanwhile, never a later holder’s child of an ended pid', async () => {
    const w = world(table, { attached: { ...attached, 110: 101, 111: 101 }, gui: [104] });
    w.onEnd((ended) => {
      if (ended === key(S)) w.add(entry(110, 102, 1700)); // started as the server was ended
      if (ended === key(C)) {
        // Pid 103 is taken at once by a process that starts 111 on the console.
        w.add(entry(103, 1, 9000), entry(111, 103, 9100));
      }
    });
    const { child } = launcher(100);
    await stopProcess(server(child), 'win32', {
      processes: w.processes,
      inspector: w.inspector,
      terminate: w.terminate,
      subsystem: async () => 3,
      now: () => 5000,
    });
    expect(w.ended).toEqual([key(S), key(C), key(O), '110@1700']);
  });

  it('ends only the launcher, by its handle, for a pid the table cannot vouch for', async () => {
    // Pid 100 was taken at 5000, long after the launcher was started.
    const w = world(
      [entry(100, 50, 5000), entry(101, 100, 5001, 'conhost.exe'), entry(102, 100, 5010)],
      {
        attached: { 100: 101, 102: 101 },
      },
    );
    const { child, signals } = launcher(100);
    await stopProcess(server(child), 'win32', {
      processes: w.processes,
      inspector: w.inspector,
      terminate: w.terminate,
    });
    expect(signals).toEqual([undefined]);
    expect(w.classified).toEqual([]);
    expect(w.terminated).toEqual([]);
  });

  it('ends only the launcher, by its handle, when the table cannot be read', async () => {
    const w = world(table, { attached });
    const { child, signals } = launcher(100);
    await stopProcess(server(child), 'win32', {
      processes: () => Promise.reject(new Error('no table')),
      inspector: w.inspector,
      terminate: w.terminate,
    });
    expect(signals).toEqual([undefined]);
    expect(w.classified).toEqual([]);
    expect(w.terminated).toEqual([]);
  });

  it('ends the launcher and its native server alone without a helper', async () => {
    const w = world(table, { attached });
    const { child, signals } = launcher(100);
    await stopProcess(server(child), 'win32', {
      processes: w.processes,
      inspector: null,
      terminate: w.terminate,
      subsystem: async (e) => (e.name === 'gui.exe' ? 2 : 3),
    });
    expect(signals).toEqual([undefined]);
    expect(w.terminated).toEqual([102]);
  });

  it('goes by the table alone when the helper no longer holds the console’s host', async () => {
    const w = world(
      table.filter((e) => e !== H),
      { attached },
    );
    // The host is gone from the helper's view, though the table still lists it.
    const inspector = {
      classify: (list: readonly { pid: number; createdAtMs: number }[]) =>
        w.inspector.classify(list.filter((p) => p.pid !== H.pid)),
    };
    const { child } = launcher(100);
    await stopProcess(server(child), 'win32', {
      processes: async () => table,
      inspector,
      terminate: w.terminate,
      subsystem: async () => 3,
    });
    expect(w.ended).toEqual([]);
    expect(w.terminated).toEqual([102]);
    expect(w.released()).toBe(1);
  });

  it('keeps POSIX on SIGTERM to the launcher alone', async () => {
    let read = false;
    const { child, signals } = launcher(100);
    await stopProcess(server(child), 'linux', {
      processes: async () => {
        read = true;
        return table;
      },
    });
    expect(signals).toEqual(['SIGTERM']);
    expect(read).toBe(false);
  });
});

/**
 * The npm launcher: runs `node agent.mjs …` as codex.js runs the native
 * server, on its own console, and says when it has.
 */
const LAUNCHER =
  "const s = require('node:child_process').spawn(process.execPath, process.argv.slice(1), { stdio: 'ignore' });" +
  "process.stdout.write('SERVER ' + s.pid + '\\n'); setInterval(() => {}, 1e9);";

describe.runIf(process.platform === 'win32')('a Codex session’s end on Windows', () => {
  const markers: string[] = [];
  afterEach(async () => {
    for (const marker of markers.splice(0)) await stopMarked(marker);
  });

  it('ends the server and what is attached to its console, never what left it', async () => {
    const tree = await writeSparedTree();
    markers.push(tree.marker);
    // As the daemon starts it: hidden, with no inherited stdio, so in a console of its own.
    const startedAtMs = Date.now();
    const child = spawn(process.execPath, ['-e', LAUNCHER, ...tree.args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const spawnedAtMs = Date.now();
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const members = await sparedTreeMembers(tree.marker, 2);
    const ending = members.filter((e) =>
      ['agent', 'attached', 'orphan-attached'].includes(role(e)),
    );
    const left = members.filter((e) => !ending.includes(e));
    expect(left.map(role).sort()).toEqual(
      ['detached', 'gui', 'gui-child', 'gui-child', 'start-process'].sort(),
    );
    await stopProcess({ child, startedAtMs, spawnedAtMs }, 'win32');
    await exited;
    expect(await survivors(ending)).toEqual([]);
    expect((await stillRunning(left)).map(role).sort()).toEqual(left.map(role).sort());
  });
});
