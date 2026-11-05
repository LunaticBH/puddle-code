import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WindowsProcess } from '@puddle/shared/node/platform';
import { windowsProcessTree } from '@puddle/shared/node/platform';
import { reapExited, tracked, type ExitedChild } from './child-lifetimes.js';

/**
 * The e2e helpers' record of a fixture's lifetime (cli/e2e/helpers.ts),
 * which bounds what is stopped once it has exited: its own orphans, never
 * the children of a later holder of its pid.
 */

const fakeChild = (pid: number) => Object.assign(new EventEmitter(), { pid });

describe('tracked children', () => {
  it('bound what is stopped by when the child exited, not by when it is stopped', async () => {
    let clock = 1000;
    const child = tracked(
      () => fakeChild(10),
      () => clock,
    );
    clock = 2000;
    child.emit('exit', 0);
    // Minutes later its pid names another process, which started a child.
    clock = 300_000;
    const table: WindowsProcess[] = [
      { pid: 11, ppid: 10, name: 'node.exe', command: 'node', commandLine: '', createdAtMs: 1500 },
      {
        pid: 12,
        ppid: 10,
        name: 'node.exe',
        command: 'node',
        commandLine: '',
        createdAtMs: 200_000,
      },
    ];
    const seen: ExitedChild[] = [];
    let stopped: number[] = [];
    await reapExited(
      child,
      async (exited) => {
        seen.push(exited);
        stopped = windowsProcessTree(table, exited).map((p) => p.pid);
      },
      () => clock,
    );
    expect(seen).toEqual([{ pid: 10, startedAtMs: 1000, exitedAtMs: 2000 }]);
    expect(stopped).toEqual([11]);
  });

  it('stop what a child left once, however often they are stopped', async () => {
    const child = tracked(() => fakeChild(10));
    child.emit('exit', 0);
    let runs = 0;
    const stop = async () => void runs++;
    expect(await reapExited(child, stop)).toBe(true);
    expect(await reapExited(child, stop)).toBe(false);
    expect(runs).toBe(1);
  });

  it('stop nothing for a child that was not tracked or has no pid', async () => {
    let runs = 0;
    const stop = async () => void runs++;
    expect(await reapExited(fakeChild(10), stop)).toBe(false);
    const pidless = tracked(() => Object.assign(new EventEmitter(), { pid: undefined }));
    expect(await reapExited(pidless, stop)).toBe(false);
    expect(runs).toBe(0);
  });
});
