import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  isPidAlive,
  killProcessTree,
  listWindowsProcesses,
  stopWindowsProcessTree,
  windowsDescendantsOf,
  windowsProcessTree,
  type WindowsProcess,
} from '../src/node/platform.js';

/**
 * Windows process trees as the process table shows them (docs/windows.md,
 * decision 8). Tables are stand-ins, so this runs on any OS; the last block
 * stops real processes on Windows.
 */

/** What killProcessTree runs (taskkill.exe), recorded on its way through. */
const executed = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: ((file: string, ...rest: unknown[]) => {
      executed.push(file);
      return (actual.execFile as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.execFile,
  };
});

const entry = (
  pid: number,
  ppid: number,
  createdAtMs: number | null,
  name = 'node.exe',
): WindowsProcess => ({
  pid,
  ppid,
  name,
  command: name.replace(/\.exe$/i, '').toLowerCase(),
  commandLine: `${name} ${pid}`,
  createdAtMs,
});
const pids = (entries: readonly WindowsProcess[]) => entries.map((e) => e.pid);

describe('windowsProcessTree', () => {
  // 10 (root, created at 1000) → 11 → 12, and 10 → 13; 20 is unrelated.
  const table = [
    entry(10, 1, 1000),
    entry(11, 10, 1100),
    entry(12, 11, 1200),
    entry(13, 10, 1300),
    entry(20, 1, 900),
    // An earlier holder of pid 10 left this child: it is older than the root.
    entry(30, 10, 500),
    entry(0, 0, null, 'System Idle Process'),
  ];

  it('takes a running root and every creation-consistent descendant, parents first', () => {
    expect(pids(windowsProcessTree(table, { pid: 10, startedAtMs: 990 }))).toEqual([
      10, 11, 13, 12,
    ]);
    expect(pids(windowsProcessTree(table, { pid: 10, createdAtMs: 1000 }))).toEqual([
      10, 11, 13, 12,
    ]);
    expect(pids(windowsProcessTree(table, { pid: 10 }))).toEqual([10, 11, 13, 12]);
  });

  it('never takes a holder created after the root could have been for the root', () => {
    // The root was started at 2000 and had to exist by 3000: pid 10 now names another process.
    const later = [entry(10, 1, 5000), entry(11, 10, 5100)];
    expect(
      windowsProcessTree(later, { pid: 10, startedAtMs: 2000, createdBeforeMs: 3000 }),
    ).toEqual([]);
    expect(windowsProcessTree(later, { pid: 10, createdAtMs: 2500 })).toEqual([]);
    // Nor one older than the root's start, beyond the clock's slack.
    expect(windowsProcessTree(table, { pid: 10, startedAtMs: 1500 })).toEqual([]);
  });

  it('finds a dead root’s orphans by their creation within its lifetime', () => {
    const orphans = [
      entry(11, 10, 1100), // the root's child, its parent gone
      entry(12, 11, 1200),
      entry(30, 10, 500), // an earlier holder's
    ];
    expect(pids(windowsProcessTree(orphans, { pid: 10, startedAtMs: 1000 }))).toEqual([11, 12]);
    expect(pids(windowsProcessTree(orphans, { pid: 10, createdAtMs: 1000 }))).toEqual([11, 12]);
    // Children created after the root's exit are not its own.
    expect(
      pids(
        windowsProcessTree([...orphans, entry(14, 10, 9000)], {
          pid: 10,
          startedAtMs: 1000,
          exitedAtMs: 2000,
        }),
      ),
    ).toEqual([11, 12]);
  });

  it('leaves a later holder of a dead root’s pid its own children', () => {
    const reused = [
      entry(10, 1, 3000), // took the pid after the root exited
      entry(11, 10, 1100), // the root's orphan
      entry(15, 10, 3100), // the new holder's child
    ];
    expect(
      pids(windowsProcessTree(reused, { pid: 10, startedAtMs: 1000, exitedAtMs: 2000 })),
    ).toEqual([11]);
    expect(pids(windowsProcessTree(reused, { pid: 10, createdAtMs: 1000 }))).toEqual([11]);
  });

  it('bounds a dead root’s orphans by when it must have exited, though nobody holds its pid', () => {
    // A short-lived process took pid 10 after the root exited, started 16 and exited too.
    const orphans = [entry(11, 10, 1100), entry(16, 10, 6000)];
    expect(
      pids(windowsProcessTree(orphans, { pid: 10, startedAtMs: 1000, exitedBeforeMs: 5000 })),
    ).toEqual([11]);
    // Without a bound every later process naming the pid counts.
    expect(pids(windowsProcessTree(orphans, { pid: 10, startedAtMs: 1000 }))).toEqual([11, 16]);
    // The bound does not make a running root count as exited.
    expect(
      pids(
        windowsProcessTree([entry(10, 1, 1000), ...orphans], {
          pid: 10,
          startedAtMs: 1000,
          exitedBeforeMs: 5000,
        }),
      ),
    ).toEqual([10, 11, 16]);
  });

  it('finds nothing below a dead root it cannot date', () => {
    expect(windowsProcessTree([entry(11, 10, 1100)], { pid: 10 })).toEqual([]);
  });

  it('never follows a process whose creation time Windows withholds', () => {
    expect(
      pids(windowsProcessTree([entry(10, 1, 1000), entry(11, 10, null)], { pid: 10 })),
    ).toEqual([10]);
    expect(windowsProcessTree(table, { pid: 0 })).toEqual([]);
  });
});

describe('windowsDescendantsOf', () => {
  it('follows parents from an earlier table, up to a later holder of their pid', () => {
    const earlier = [entry(11, 10, 1100)];
    const now = [
      entry(12, 11, 1200), // 11 has exited; its child remains
      entry(11, 1, 4000), // pid 11 was reused
      entry(16, 11, 4100), // the new holder's child
    ];
    expect(pids(windowsDescendantsOf(now, earlier))).toEqual([12]);
    expect(pids(windowsDescendantsOf(now.slice(0, 1), earlier))).toEqual([12]);
  });

  it('follows a parent that has exited, its pid held by nobody, only up to its exit bound', () => {
    const earlier = [entry(11, 10, 1100)];
    const now = [
      entry(12, 11, 1200), // 11's child
      entry(16, 11, 4100), // a child of a short-lived later holder of pid 11
    ];
    expect(pids(windowsDescendantsOf(now, earlier, () => 3000))).toEqual([12]);
    expect(pids(windowsDescendantsOf(now, earlier, () => undefined))).toEqual([12, 16]);
    // A parent still running keeps every child, whatever its bound.
    expect(pids(windowsDescendantsOf([entry(11, 10, 1100), ...now], earlier, () => 3000))).toEqual([
      12, 16,
    ]);
  });
});

/** A stand-in table that changes as processes are stopped (and as they start). */
function world(initial: WindowsProcess[]) {
  let processes = [...initial];
  const reads: Array<{ fresh: boolean }> = [];
  const terminated: number[] = [];
  const hooks: Array<(pid: number) => void> = [];
  return {
    reads,
    terminated,
    add: (...more: WindowsProcess[]) => processes.push(...more),
    onTerminate: (hook: (pid: number) => void) => hooks.push(hook),
    processes: async (options?: { fresh?: boolean }) => {
      reads.push({ fresh: options?.fresh === true });
      return [...processes];
    },
    terminate: (pid: number) => {
      terminated.push(pid);
      processes = processes.filter((p) => p.pid !== pid);
      for (const hook of hooks) hook(pid);
    },
  };
}

describe('stopWindowsProcessTree', () => {
  it('stops a running root and its tree, parents first, from fresh reads', async () => {
    const w = world([
      entry(10, 1, 1000),
      entry(11, 10, 1100),
      entry(12, 11, 1200),
      entry(20, 1, 1),
    ]);
    const stopped = await stopWindowsProcessTree(10, {
      processes: w.processes,
      root: { startedAtMs: 1000 },
      terminate: w.terminate,
    });
    expect(w.terminated).toEqual([10, 11, 12]);
    expect(pids(stopped)).toEqual([10, 11, 12]);
    expect(w.reads.every((read) => read.fresh)).toBe(true);
  });

  it('stops a child started between the read and its parent’s end', async () => {
    const w = world([entry(10, 1, 1000), entry(11, 10, 1100)]);
    // 11 starts 12 just as 10 is stopped.
    w.onTerminate((pid) => {
      if (pid === 10) w.add(entry(12, 11, 1500));
    });
    await stopWindowsProcessTree(10, {
      processes: w.processes,
      root: { createdAtMs: 1000 },
      terminate: w.terminate,
    });
    expect(w.terminated).toEqual([10, 11, 12]);
  });

  it('stops known members whose parent has exited, and their descendants', async () => {
    const w = world([entry(13, 12, 1300), entry(14, 13, 1400), entry(15, 12, 1500)]);
    // 12 was seen below the root earlier; it and the root have exited since.
    const known = [entry(11, 10, 1100), entry(12, 11, 1200)];
    await stopWindowsProcessTree(10, {
      processes: w.processes,
      root: { createdAtMs: 1000 },
      known,
      terminate: w.terminate,
    });
    expect(w.terminated.sort()).toEqual([13, 14, 15]);
  });

  it('counts a stopped process’s children only up to when it was stopped', async () => {
    let clock = 2000;
    const w = world([entry(10, 1, 1000), entry(11, 10, 1100)]);
    w.onTerminate((pid) => {
      if (pid !== 11) return;
      // Started by 11 just before its end: found by the next read.
      w.add(entry(12, 11, 1900));
      // Pid 11 is taken at once by a process that starts 13 and exits.
      clock = 5000;
      w.add(entry(13, 11, 4000));
    });
    await stopWindowsProcessTree(10, {
      processes: w.processes,
      root: { createdAtMs: 1000 },
      terminate: w.terminate,
      now: () => clock,
    });
    expect(w.terminated).toEqual([10, 11, 12]);
  });

  it('counts the children of a known member that has exited only up to when it was read', async () => {
    // 12 was seen at 3000, below the root; it has exited since, and its pid was
    // taken by a short-lived process that started 17.
    const w = world([entry(13, 12, 1300), entry(17, 12, 3500)]);
    await stopWindowsProcessTree(10, {
      processes: w.processes,
      root: { startedAtMs: 1000, exitedAtMs: 3000 },
      known: [entry(12, 11, 1200)],
      knownAtMs: 3000,
      terminate: w.terminate,
    });
    expect(w.terminated).toEqual([13]);
  });

  it('reads the table once when nothing is left to stop, using a table it is given', async () => {
    const w = world([entry(20, 1, 1)]);
    expect(
      await stopWindowsProcessTree(10, {
        processes: w.processes,
        root: { startedAtMs: 1000, exitedAtMs: 2000 },
        table: [entry(20, 1, 1)],
        terminate: w.terminate,
      }),
    ).toEqual([]);
    expect(w.reads).toEqual([]);
  });

  it('never stops this process, and survives a process that cannot be stopped', async () => {
    const w = world([entry(10, 1, 1000), entry(process.pid, 10, 1100), entry(12, 10, 1200)]);
    const stopped = await stopWindowsProcessTree(10, {
      processes: w.processes,
      root: { createdAtMs: 1000 },
      terminate: (pid) => {
        if (pid === 12) throw Object.assign(new Error('denied'), { code: 'EPERM' });
        w.terminate(pid);
      },
    });
    expect(w.terminated).toEqual([10]);
    expect(pids(stopped)).toEqual([10, 12]);
  });

  it('rejects when the table cannot be read', async () => {
    await expect(
      stopWindowsProcessTree(10, {
        processes: () => Promise.reject(new Error('no table')),
        terminate: () => {},
      }),
    ).rejects.toThrow('no table');
  });
});

describe('killProcessTree with a process table', () => {
  it('keeps POSIX on its signals, whatever table it is given', async () => {
    let read = false;
    await killProcessTree(2 ** 30, {
      platform: 'linux',
      processes: async () => {
        read = true;
        return [];
      },
    });
    expect(read).toBe(false);
  });

  it('stops nothing when the table cannot be read: never taskkill on a pid that may be reused', async () => {
    executed.length = 0;
    await expect(
      killProcessTree(2 ** 30, {
        platform: 'win32',
        processes: () => Promise.reject(new Error('no table')),
      }),
    ).resolves.toBeUndefined();
    expect(executed.filter((file) => /taskkill/i.test(file))).toEqual([]);
  });

  it('still runs taskkill without a table', async () => {
    executed.length = 0;
    // A pid no process holds: taskkill (or its absence off Windows) finds nothing.
    await killProcessTree(2 ** 30, { platform: 'win32' });
    expect(executed.filter((file) => /taskkill/i.test(file))).toHaveLength(1);
  });
});

describe.runIf(process.platform === 'win32')('stopWindowsProcessTree on Windows', () => {
  it('stops a grandchild whose parent has already exited, beyond taskkill /T’s reach', async () => {
    const startedAtMs = Date.now();
    // The child starts a detached grandchild, prints its pid and exits.
    const script =
      "const { spawn } = require('node:child_process');" +
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });" +
      'process.stdout.write(String(g.pid)); g.unref();';
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += String(chunk)));
    await new Promise((resolve) => child.once('exit', resolve));
    const grandchild = Number(out);
    // The grandchild names the dead child's pid as its parent.
    const middle = (await listWindowsProcesses({ fresh: true })).find((p) => p.pid === grandchild);
    expect(middle?.ppid).toBe(child.pid);
    try {
      const stopped = await stopWindowsProcessTree(child.pid!, {
        processes: listWindowsProcesses,
        root: { startedAtMs, exitedAtMs: Date.now() },
      });
      expect(pids(stopped)).toContain(grandchild);
      for (let i = 0; i < 80 && isPidAlive(grandchild); i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(isPidAlive(grandchild)).toBe(false);
    } finally {
      if (isPidAlive(grandchild)) process.kill(grandchild);
    }
  });
});
