import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { childProcessTree, type WindowsProcess } from '@puddle/shared/node/platform';
import { mayEndTree, ownConsoleHost, stopOwnConsole } from '../../src/pty/own-console.js';
import { entry, key, world } from '../helpers/console-world.js';
import { role, stillRunning, stopMarked, survivors } from '../helpers/process-trees.js';
import { sparedTreeMembers, writeSparedTree } from '../helpers/spared-trees.js';

/**
 * Ending a daemon child that has a console of its own (docs/windows.md,
 * decision 8): the child by its handle and what the ConPTY helper finds
 * attached to the console's host, never a GUI programme or what one started,
 * nor what left the console. Stand-in tables and helper, on any OS.
 */

/** The root (100), started between 995 and 1005, and the console host it created (101). */
const R = entry(100, 50, 1000, 'cmd.exe');
const H = entry(101, 100, 1001, 'conhost.exe');
const A = entry(102, 100, 1010); // attached, through the root
const D = entry(103, 100, 1020); // detached: no console
const N = entry(104, 100, 1030); // in a console of its own (Start-Process)
const NH = entry(105, 104, 1031, 'conhost.exe'); // that console's host
const O = entry(106, 999, 1040); // on the console, left there by `cmd /c start /b`
const G = entry(107, 100, 1050, 'gui.exe'); // a GUI programme that attached to it
const GC = entry(108, 107, 1060); // a console programme that one started there
const U = entry(200, 1, 1070); // another console's orphan
const table = [R, H, A, D, N, NH, O, G, GC, U];
const attached = { 100: 101, 102: 101, 104: 105, 106: 101, 107: 101, 108: 101, 200: 300 };
const root = { pid: 100, startedAtMs: 995, createdBeforeMs: 1005 };

describe('ending a child’s own console on Windows', () => {
  it('ends the root by its handle and what is attached to its console, as POSIX setsid spares the rest', async () => {
    const w = world(table, { attached, gui: [107] });
    let rootEnded = 0;
    const ended = await stopOwnConsole(root, () => rootEnded++, {
      processes: w.processes,
      inspector: w.inspector,
      subsystem: async () => 3,
    });
    expect(ended).toBe('ended');
    expect(rootEnded).toBe(1);
    expect(w.ended).toEqual([key(A), key(O)]);
    expect(w.released()).toBe(w.classified.length);
  });

  it('ends what is left on the console of a root that has exited, by its exit time', async () => {
    // The root exited at 2000; the host lives on while the orphan is attached.
    const w = world(
      table.filter((e) => e !== R),
      { attached, gui: [107] },
    );
    let rootEnded = 0;
    const ended = await stopOwnConsole({ ...root, exitedAtMs: 2000 }, () => rootEnded++, {
      processes: w.processes,
      inspector: w.inspector,
      subsystem: async () => 3,
    });
    expect(ended).toBe('ended');
    expect(rootEnded).toBe(0);
    expect(w.ended).toEqual([key(A), key(O)]);
  });

  it('ends nothing for a root that has exited at a time unknown', async () => {
    const w = world(
      table.filter((e) => e !== R),
      { attached },
    );
    const ended = await stopOwnConsole(root, () => {}, {
      processes: w.processes,
      inspector: w.inspector,
    });
    expect(ended).toBe('closed');
    expect(w.classified).toEqual([]);
  });

  it('takes the exit of a child’s root that the table no longer shows from after the read', async () => {
    // The root exited as the table was read; its exit was noted since.
    const w = world(
      table.filter((e) => e !== R),
      { attached, gui: [107] },
    );
    let reads = 0;
    const ended = await stopOwnConsole(
      () => (reads++ === 0 ? root : { ...root, exitedAtMs: 2000 }),
      () => {},
      { processes: w.processes, inspector: w.inspector, subsystem: async () => 3 },
    );
    expect(ended).toBe('ended');
    expect(w.ended).toEqual([key(A), key(O)]);
    // Not noted yet: libuv holds the root's pid until it is, so the table's
    // processes that name it are its own.
    const zombie = world(
      table.filter((e) => e !== R),
      { attached, gui: [107] },
    );
    expect(
      await stopOwnConsole(
        () => root,
        () => {},
        {
          processes: zombie.processes,
          inspector: zombie.inspector,
          subsystem: async () => 3,
        },
      ),
    ).toBe('ended');
    expect(zombie.ended).toEqual([key(A), key(O)]);
  });

  it('keeps a root the table shows running though its exit is noted after the read', async () => {
    const w = world(table, { attached, gui: [107] });
    let reads = 0;
    let rootEnded = 0;
    const ended = await stopOwnConsole(
      () => (reads++ === 0 ? root : { ...root, exitedAtMs: 2000 }),
      () => rootEnded++,
      { processes: w.processes, inspector: w.inspector, subsystem: async () => 3 },
    );
    expect(ended).toBe('ended');
    expect(rootEnded).toBe(1);
    expect(w.ended).toEqual([key(A), key(O)]);
  });

  it('ends nothing without a helper, a table, or a console host', async () => {
    const w = world(table, { attached });
    const endRoot = () => {
      throw new Error('ended');
    };
    expect(await stopOwnConsole(root, endRoot, { processes: w.processes, inspector: null })).toBe(
      'unavailable',
    );
    expect(
      await stopOwnConsole(root, endRoot, {
        processes: () => Promise.reject(new Error('no table')),
        inspector: w.inspector,
      }),
    ).toBe('unavailable');
    // A GUI root has no console of its own; nor has one whose console has closed.
    const gui = world(
      table.filter((e) => e !== H),
      { attached },
    );
    expect(
      await stopOwnConsole(root, endRoot, { processes: gui.processes, inspector: gui.inspector }),
    ).toBe('closed');
    // Without the helper up, nothing tells that the console has closed.
    expect(
      await stopOwnConsole(root, endRoot, {
        processes: gui.processes,
        inspector: { ...gui.inspector, ready: async () => false },
      }),
    ).toBe('unavailable');
    expect(w.ended).toEqual([]);
  });

  it('lets a tree end in its stead only without the helper, or for a root that never had a console', async () => {
    const console = async () => 3;
    const gui = async () => 2;
    expect(await mayEndTree('unavailable', 'x.exe', console)).toBe(true);
    expect(await mayEndTree('ended', 'x.exe', gui)).toBe(false);
    // A console closed: what left it is to outlive it, as `setsid` does.
    expect(await mayEndTree('closed', 'x.exe', console)).toBe(false);
    expect(await mayEndTree('closed', 'x.exe', async () => null)).toBe(false);
    expect(await mayEndTree('closed', 'x.exe', gui)).toBe(true);
  });

  it('ends no other console’s process, nor one created before the host', async () => {
    // 109 names the host's pid but is older: a process of an earlier holder of that pid's.
    const old = entry(109, 999, 900);
    const w = world([...table, old], { attached: { ...attached, 109: 101 } });
    await stopOwnConsole(root, () => {}, {
      processes: w.processes,
      inspector: w.inspector,
      subsystem: async () => 3,
    });
    expect(w.ended).not.toContain(key(old));
    expect(w.ended).not.toContain(key(U));
  });

  it('takes its own console’s host, never a pseudoconsole’s', () => {
    const headless: WindowsProcess = {
      ...entry(110, 100, 1000.5, 'conhost.exe'),
      commandLine: 'conhost.exe --headless --width 80 --height 24',
    };
    expect(ownConsoleHost([R, headless, H, NH], 100)).toBe(H);
    expect(ownConsoleHost([R, headless], 100)).toBeUndefined();
  });
});

/**
 * Real processes: two children started as the daemon starts its compile
 * commands and bridges (hidden, no inherited stdio), each running the
 * spared tree. Each has a console of its own, so ending one's ends nothing
 * of the other's, its orphan on its console included.
 */
describe.runIf(process.platform === 'win32')('a child’s own console on Windows', () => {
  const markers: string[] = [];
  const children: ChildProcess[] = [];
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
    for (const marker of markers.splice(0)) await stopMarked(marker);
  });

  async function start() {
    const tree = await writeSparedTree();
    markers.push(tree.marker);
    const startedAtMs = Date.now();
    const child = spawn(process.execPath, tree.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.push(child);
    const processTree = childProcessTree(child, startedAtMs);
    return { child, processTree, members: await sparedTreeMembers(tree.marker) };
  }

  it('is the child’s alone: ending it ends nothing of another child’s', async () => {
    const [one, other] = [await start(), await start()];
    const exited = new Promise((resolve) => one.child.once('exit', resolve));
    const ended = await stopOwnConsole({ pid: one.child.pid!, ...one.processTree.root() }, () =>
      one.child.kill(),
    );
    expect(ended).toBe('ended');
    await exited;
    const ending = one.members.filter((e) =>
      ['agent', 'attached', 'orphan-attached'].includes(role(e)),
    );
    expect(await survivors(ending, 0)).toEqual([]);
    const spared = one.members.filter((e) => !ending.includes(e));
    expect((await stillRunning(spared)).map(role).sort()).toEqual(spared.map(role).sort());
    expect((await stillRunning(other.members)).map(role).sort()).toEqual(
      other.members.map(role).sort(),
    );
  });
});
