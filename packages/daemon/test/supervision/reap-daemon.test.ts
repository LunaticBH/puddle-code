import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WindowsProcess } from '@puddle/shared/node/platform';
import { ptyRootsFile, readPtyRoots, writePtyRoots } from '../../src/pty/pty-roots.js';
import { reapWindowsDaemon } from '../../src/supervision/reap-daemon.js';

/**
 * What the Windows supervisor stops after its daemon exits, against stand-in
 * process tables (runs on any OS; windows-daemon-teardown.test.ts runs it
 * against a real daemon).
 */

const entry = (pid: number, ppid: number, createdAtMs: number): WindowsProcess => ({
  pid,
  ppid,
  name: 'node.exe',
  command: 'node',
  commandLine: `node.exe ${pid}`,
  createdAtMs,
});

function world(initial: WindowsProcess[]) {
  let processes = [...initial];
  const terminated: number[] = [];
  return {
    terminated,
    processes: async () => [...processes],
    terminate: (pid: number) => {
      terminated.push(pid);
      processes = processes.filter((p) => p.pid !== pid);
    },
  };
}

describe('reapWindowsDaemon', () => {
  // The daemon (pid 100) ran from 1000 to 5000; its PTY root 10 was spawned at 2000.
  const daemon = { pid: 100, startedAtMs: 1000 };

  it('stops what its ConPTY roots and the daemon itself left, then forgets the roots', async () => {
    const rootsFile = ptyRootsFile(mkdtempSync(join(tmpdir(), 'puddle-reap-')));
    writePtyRoots(rootsFile, 100, [{ pid: 10, startedAtMs: 2000, spawnedAtMs: 2010 }]);
    const w = world([
      entry(11, 10, 2100), // the PTY root's detached child; the root died with the daemon
      entry(12, 11, 2200),
      entry(13, 100, 3000), // something the daemon started itself
      entry(14, 100, 500), // an earlier holder of the daemon's pid left this
      entry(15, 10, 9000), // a later holder of the root's pid started this
      entry(10, 1, 8000), // that later holder
    ]);
    const count = await reapWindowsDaemon(daemon, 5000, {
      processes: w.processes,
      rootsFile,
      terminate: w.terminate,
    });
    expect(w.terminated).toEqual([11, 12, 13]);
    expect(count).toBe(3);
    expect(existsSync(rootsFile)).toBe(false);
  });

  it('leaves another daemon’s record alone', async () => {
    const rootsFile = ptyRootsFile(mkdtempSync(join(tmpdir(), 'puddle-reap-')));
    writePtyRoots(rootsFile, 200, [{ pid: 10, startedAtMs: 2000, spawnedAtMs: 2010 }]);
    const w = world([entry(11, 10, 2100)]);
    expect(
      await reapWindowsDaemon(daemon, 5000, {
        processes: w.processes,
        rootsFile,
        terminate: w.terminate,
      }),
    ).toBe(0);
    expect(w.terminated).toEqual([]);
    expect(readPtyRoots(rootsFile, 200)).toHaveLength(1);
  });

  it('stops nothing below a daemon it cannot date', async () => {
    const rootsFile = ptyRootsFile(mkdtempSync(join(tmpdir(), 'puddle-reap-')));
    const w = world([entry(13, 100, 3000)]);
    expect(
      await reapWindowsDaemon({ pid: 100 }, 5000, {
        processes: w.processes,
        rootsFile,
        terminate: w.terminate,
      }),
    ).toBe(0);
  });
});
