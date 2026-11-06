import type { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

/** Every command a stand-in stop was given, ended once its test is done. */
const stopped = new Set<Child>();
/** Each test's held stops, finished once it is done, failed or not. */
const unfinished = new Set<() => void>();

afterEach(async () => {
  unfinished.forEach((finish) => finish());
  unfinished.clear();
  const children = [...stopped];
  stopped.clear();
  await Promise.all(
    children.map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return undefined;
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      return closed;
    }),
  );
});

/**
 * A Windows stop that finishes when told. With `endsCommand`, it ends the
 * command at once, as a real stop does before it turns to the command's
 * descendants; without, the command keeps running until `finish`, so each
 * later stop asked for (the timeout's SIGKILL, the daemon's dispose) finds
 * it live and reaches the command's stop while this one is held.
 */
function heldStop({ endsCommand }: { endsCommand: boolean }) {
  const calls: Child[] = [];
  const finishes: Array<() => void> = [];
  const options: CompilationStopOptions = {
    platform: 'win32',
    stopWindows: (child) => {
      calls.push(child);
      stopped.add(child);
      if (endsCommand) child.kill('SIGKILL');
      return new Promise<void>((resolve) => finishes.push(resolve));
    },
  };
  const finish = (): void => {
    for (const child of calls) child.kill('SIGKILL');
    finishes.splice(0).forEach((resolve) => resolve());
  };
  unfinished.add(finish);
  return { calls, options, finish };
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
    const stop = heldStop({ endsCommand: false });
    const error = await runCompilationCommand(longCommand(), stop.options).catch(
      (caught: unknown) => caught,
    );
    expect(String(error)).toMatch(/exceeded 100 ms/);
    expect(stop.calls).toHaveLength(1);
    const [child] = stop.calls;
    // The command is still running a second on, so the timeout's SIGKILL
    // asks for its stop again, and joins the one under way.
    await pause(1_300);
    expect(child?.exitCode).toBeNull();
    expect(stop.calls).toHaveLength(1);
    // So does the daemon's dispose, which finds the command still live.
    const disposed = disposeCompilationCommands();
    expect(stop.calls).toHaveLength(1);
    expect(await within(disposed, 100)).toBe(false);
    expect(stop.calls).toHaveLength(1);
    stop.finish();
    expect(await within(disposed, 1_000)).toBe(true);
    expect(stop.calls).toHaveLength(1);
  });

  it('has dispose wait for a stop that outlives its command’s close', async () => {
    const stop = heldStop({ endsCommand: true });
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
