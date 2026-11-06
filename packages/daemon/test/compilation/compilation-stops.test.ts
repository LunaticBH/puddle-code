import type { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  disposeCompilationCommands,
  runCompilationCommand,
  type CompilationStopOptions,
} from '../../src/compilation/process.js';

/**
 * A compile command's Windows stops (docs/windows.md, decision 8), with the
 * stop itself a stand-in, so this runs on any OS: each stop reads its own
 * process table, so two never run at once, and the daemon's dispose waits
 * for every one still under way, its command closed or not.
 */

type Child = ReturnType<typeof spawn>;

/** A Windows stop that ends the command at once and finishes when told. */
function heldStop() {
  const calls: Child[] = [];
  const finishes: Array<() => void> = [];
  const options: CompilationStopOptions = {
    platform: 'win32',
    stopWindows: (child) => {
      calls.push(child);
      child.kill('SIGKILL');
      return new Promise<void>((resolve) => finishes.push(resolve));
    },
  };
  return { calls, options, finish: () => finishes.splice(0).forEach((finish) => finish()) };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether `promise` settles within `ms`. */
const within = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), pause(ms).then(() => false)]);

/** A command that runs until it is ended, timed out at 100 ms. */
function longCommand() {
  return {
    file: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: mkdtempSync(join(tmpdir(), 'puddle-stops-')),
    timeoutMs: 100,
  };
}

describe('a compile command’s Windows stops', () => {
  it('never starts a second stop while the first runs', async () => {
    const stop = heldStop();
    const error = await runCompilationCommand(longCommand(), stop.options).catch(
      (caught: unknown) => caught,
    );
    expect(String(error)).toMatch(/exceeded 100 ms/);
    expect(stop.calls).toHaveLength(1);
    // The SIGKILL a second on joins the stop under way, as dispose does.
    await pause(1_300);
    const disposed = disposeCompilationCommands();
    expect(stop.calls).toHaveLength(1);
    expect(await within(disposed, 100)).toBe(false);
    stop.finish();
    expect(await within(disposed, 1_000)).toBe(true);
  });

  it('has dispose wait for a stop that outlives its command’s close', async () => {
    const stop = heldStop();
    await runCompilationCommand(longCommand(), stop.options).catch(() => undefined);
    // The stop ended the command, which has closed (and left the live
    // commands) since; the stop itself is still ending its descendants.
    await pause(300);
    const disposed = disposeCompilationCommands();
    expect(await within(disposed, 100)).toBe(false);
    stop.finish();
    expect(await within(disposed, 1_000)).toBe(true);
    expect(stop.calls).toHaveLength(1);
  });
});
