import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { stopProcess } from '../../src/agents/codex/lifecycle.js';
import { entry, key, world } from '../helpers/console-world.js';
import { role, stillRunning, stopMarked, survivors } from '../helpers/process-trees.js';
import { consoleProgram, sparedTreeMembers, writeSparedTree } from '../helpers/spared-trees.js';

/**
 * Ending a Codex app-server on Windows (docs/windows.md, decision 8): the
 * launcher the daemon started, by its handle, and what is attached to its
 * console, by the ConPTY helper's holds; never a GUI programme or what one
 * started, a detached process or one in a console of its own, nor a process
 * the process table cannot vouch for. Tables and the helper are stand-ins
 * first, so this runs on any OS; the last block ends real processes.
 */

/** A stand-in for the app-server's ChildProcess: what it was asked; `onKill` runs as it is ended. */
function launcher(pid: number, onKill?: () => void) {
  const signals: Array<string | undefined> = [];
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null,
    killed: false,
    kill: (signal?: string) => {
      signals.push(signal);
      onKill?.();
      return true;
    },
  });
  return { child: child as unknown as ChildProcess, signals, exit: () => (child.exitCode = 1) };
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

  it('ends the native server, then the launcher, alone without a helper', async () => {
    const w = world(table, { attached });
    const order: string[] = [];
    // As libuv's kill-on-close job does, ending the launcher ends its server,
    // whose pid is taken at once by an unrelated process.
    const { child, signals } = launcher(100, () => {
      order.push('launcher');
      w.terminate(102);
      w.add(entry(102, 1, 9000));
    });
    await stopProcess(server(child), 'win32', {
      processes: w.processes,
      inspector: null,
      terminate: (pid) => {
        order.push(`terminate ${pid}`);
        w.terminate(pid);
      },
      subsystem: async (e) => (e.name === 'gui.exe' ? 2 : 3),
    });
    expect(signals).toEqual([undefined]);
    expect(order).toEqual(['terminate 102', 'launcher']);
    expect((await w.processes()).filter((e) => e.pid === 102)).toEqual([entry(102, 1, 9000)]);
  });

  it('ends a native launcher alone, by its handle, without a helper', async () => {
    // winget, scoop and the GitHub releases install codex.exe itself: its
    // direct children are the commands it runs, on its console or not.
    const native = entry(100, 50, 1000, 'codex.exe');
    const commands = [entry(102, 100, 1010, 'pwsh.exe'), entry(103, 100, 1020)];
    const w = world([native, H, ...commands], { attached: { 100: 101, 102: 101 } });
    const { child, signals } = launcher(100);
    await stopProcess(server(child), 'win32', {
      processes: w.processes,
      inspector: null,
      terminate: w.terminate,
      subsystem: async () => 3,
    });
    expect(signals).toEqual([undefined]);
    expect(w.terminated).toEqual([]);
  });

  it('ends a native launcher alone when the helper no longer holds the console’s host', async () => {
    const native = entry(100, 50, 1000, 'codex.exe');
    const command = entry(103, 100, 1100, 'pwsh.exe');
    const w = world([native, H, command], { attached: { 100: 101, 103: 101 } });
    const inspector = {
      classify: (list: readonly { pid: number; createdAtMs: number }[]) =>
        w.inspector.classify(list.filter((p) => p.pid !== H.pid)),
    };
    const { child, signals } = launcher(100);
    await stopProcess(server(child), 'win32', {
      processes: w.processes,
      inspector,
      terminate: w.terminate,
      subsystem: async () => 3,
    });
    expect(signals).toEqual([undefined]);
    expect(w.ended).toEqual([]);
    expect(w.terminated).toEqual([]);
  });

  it('ends no server by pid without a helper once the launcher has exited', async () => {
    const w = world(table, { attached });
    const { child, signals, exit } = launcher(100);
    await stopProcess(server(child), 'win32', {
      processes: w.processes,
      inspector: null,
      terminate: w.terminate,
      // The launcher exits while the server's image is read: its pid vouches for nothing.
      subsystem: async () => {
        exit();
        return 3;
      },
    });
    expect(w.terminated).toEqual([]);
    expect(signals).toEqual([undefined]);
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

  it('goes by the table alone when the launcher is attached to another console', async () => {
    // The conhost.exe below the launcher is not the console it runs in.
    const w = world(table, { attached: { ...attached, 100: 300 } });
    const { child } = launcher(100);
    await stopProcess(server(child), 'win32', {
      processes: w.processes,
      inspector: w.inspector,
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

/**
 * A native launcher (`native-codex.exe <file> [args...]`), as a codex.exe
 * that runs commands: starts `<file> <args...>` on its console and waits.
 */
const NATIVE_LAUNCHER = String.raw`
using System.Diagnostics;
using System.Text;
using System.Threading;
public static class PuddleNativeCodex
{
    public static int Main(string[] args)
    {
        var line = new StringBuilder();
        for (int i = 1; i < args.Length; i++) line.Append(i > 1 ? " " : "").Append('"').Append(args[i]).Append('"');
        var start = new ProcessStartInfo(args[0], line.ToString());
        start.UseShellExecute = false;
        Process.Start(start);
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }
}
`;

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

  it('ends a native launcher alone without the helper, never what it runs', async () => {
    const tree = await writeSparedTree();
    markers.push(tree.marker);
    // As a native codex.exe: the server itself, whose children are what it runs.
    const native = await consoleProgram('native-codex', NATIVE_LAUNCHER);
    const startedAtMs = Date.now();
    const child = spawn(native, [process.execPath, ...tree.args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const spawnedAtMs = Date.now();
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const members = await sparedTreeMembers(tree.marker);
    expect(members.find((e) => role(e) === 'agent')?.ppid).toBe(child.pid);
    await stopProcess({ child, startedAtMs, spawnedAtMs }, 'win32', { inspector: null });
    await exited;
    expect((await stillRunning(members)).map(role).sort()).toEqual(members.map(role).sort());
  });

  it('ends the server, then the launcher, and nothing else without the helper', async () => {
    const tree = await writeSparedTree();
    markers.push(tree.marker);
    const startedAtMs = Date.now();
    const child = spawn(process.execPath, ['-e', LAUNCHER, ...tree.args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const spawnedAtMs = Date.now();
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const members = await sparedTreeMembers(tree.marker, 2);
    const ending = members.filter((e) => role(e) === 'agent');
    const left = members.filter((e) => !ending.includes(e));
    await stopProcess({ child, startedAtMs, spawnedAtMs }, 'win32', { inspector: null });
    await exited;
    expect(await survivors(ending)).toEqual([]);
    expect((await stillRunning(left)).map(role).sort()).toEqual(left.map(role).sort());
  });
});
