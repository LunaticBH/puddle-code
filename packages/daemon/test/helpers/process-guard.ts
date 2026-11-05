import {
  listWindowsProcesses,
  stopWindowsProcessTree,
  type WindowsProcess,
} from '@puddle/shared/node/platform';
import { isConptyJobHost } from '../../src/pty/conpty-jobs.js';

/**
 * Keeps the test suites from leaving processes behind (docs/windows.md,
 * decision 8): Windows ends nothing with its parent, so an agent, shell or
 * daemon a test forgets to stop would run on after the suite.
 *
 * - Helpers that start PTYs, daemons or fake agents register their teardown
 *   with `onTeardown`; `process-guard.setup.ts` runs every registered
 *   teardown after each test file.
 * - On Windows that setup file then stops whatever the test file still left
 *   running below its worker (a ConPTY host, a PTY root, a child daemon),
 *   naming each.
 * - On Windows `process-guard.global.ts` gives each run a temporary directory
 *   of its own, and fails the run if any process whose command line names it
 *   is still alive at the end.
 */

type Teardown = () => void | Promise<void>;

/**
 * Straight to the worker's stderr: Vitest may drop console output a file's
 * last hook writes as its worker winds down.
 */
export function report(message: string): void {
  process.stderr.write(`[process guard] ${message}\n`);
}

const TEARDOWNS = Symbol.for('puddle.test.teardowns');

/** Shared through globalThis: one registry per worker, however modules are loaded. */
function teardowns(): { pending: Set<Teardown>; used: boolean } {
  const scope = globalThis as { [TEARDOWNS]?: { pending: Set<Teardown>; used: boolean } };
  return (scope[TEARDOWNS] ??= { pending: new Set(), used: false });
}

/** Runs `teardown` after this test file, unless the returned function cancels it first. */
export function onTeardown(teardown: Teardown): () => void {
  const registry = teardowns();
  registry.used = true;
  registry.pending.add(teardown);
  return () => {
    registry.pending.delete(teardown);
  };
}

/** Whether this test file registered a teardown, run or cancelled since. */
export function teardownsRegistered(): boolean {
  return teardowns().used;
}

/** Every registered teardown, the latest first; a failure is reported, not thrown. */
export async function runTeardowns(): Promise<void> {
  const registry = teardowns();
  const pending = [...registry.pending].reverse();
  registry.pending.clear();
  registry.used = false;
  for (const teardown of pending) {
    try {
      await teardown();
    } catch (err) {
      report(`test teardown failed: ${(err as Error).message}`);
    }
  }
}

/** What stopPtys needs of a PtyManager (structural, so this module never loads node-pty). */
export interface PtyOwner {
  killAll(stream?: string, signal?: string): void;
  liveCount(): number;
  /** Windows: the process-table passes that outlasted their PTYs' deadlines. */
  settled?(ms: number): Promise<void>;
}

async function drained(ptys: PtyOwner, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (ptys.liveCount() > 0) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/**
 * Closes every live PTY as daemon shutdown does, then forces what remains;
 * on Windows each PTY reports its exit only once its whole tree is stopped.
 */
export async function stopPtys(ptys: PtyOwner): Promise<void> {
  if (ptys.liveCount() > 0) {
    ptys.killAll();
    if (!(await drained(ptys, 5000))) {
      ptys.killAll(undefined, 'SIGKILL');
      await drained(ptys, 15_000);
    }
  }
  await ptys.settled?.(15_000);
}

/** stopPtys after this test file; `before` runs first (a service's beginShutdown). */
export function stopPtysAfterFile(ptys: PtyOwner, before?: () => void): void {
  onTeardown(async () => {
    before?.();
    await stopPtys(ptys);
  });
}

/**
 * Helpers a worker keeps that end with it, not leaks: the process table's
 * PowerShell worker (which also idles out), the ConPTY job host and
 * esbuild's service.
 */
function isWorkerHelper(entry: WindowsProcess): boolean {
  const line = entry.commandLine ?? '';
  return (
    (entry.name.toLowerCase() === 'powershell.exe' &&
      (/-NonInteractive -ExecutionPolicy Bypass -Command -\s*$/i.test(line) ||
        isConptyJobHost(line))) ||
    (entry.name.toLowerCase() === 'esbuild.exe' && /\s--service=\S+/.test(line))
  );
}

export function describeProcess(entry: WindowsProcess): string {
  const line = (entry.commandLine ?? entry.name).replace(/\s+/g, ' ');
  return `${entry.pid} ${line.length > 160 ? `${line.slice(0, 157)}...` : line}`;
}

/**
 * Windows: stops every process this worker started since `sinceMs` that is
 * still running, with its descendants, apart from the worker's own helpers;
 * resolves with what it stopped. Every ConPTY host and PTY root is a
 * child of the process that spawned the PTY, and every child daemon of the
 * test that started it.
 */
export async function stopStrays(sinceMs: number): Promise<WindowsProcess[]> {
  const table = await listWindowsProcesses({ fresh: true });
  const self = table.find((entry) => entry.pid === process.pid);
  if (!self?.createdAtMs) return [];
  const since = Math.max(sinceMs, self.createdAtMs);
  const strays = table.filter(
    (entry) =>
      entry.ppid === process.pid &&
      entry.createdAtMs !== null &&
      entry.createdAtMs >= since &&
      !isWorkerHelper(entry),
  );
  const stopped: WindowsProcess[] = [];
  for (const stray of strays) {
    stopped.push(
      ...(await stopWindowsProcessTree(stray.pid, {
        processes: listWindowsProcesses,
        root: { createdAtMs: stray.createdAtMs },
      })),
    );
  }
  return stopped;
}

/**
 * Windows: stops every process whose command line names `directory`, with
 * its descendants; resolves with what it stopped.
 */
export async function stopNaming(directory: string): Promise<WindowsProcess[]> {
  const marker = directory.toLowerCase();
  const table = await listWindowsProcesses({ fresh: true });
  const named = table.filter(
    (entry) => entry.pid !== process.pid && entry.commandLine?.toLowerCase().includes(marker),
  );
  const stopped: WindowsProcess[] = [];
  for (const entry of named) {
    if (stopped.some((done) => done.pid === entry.pid && done.createdAtMs === entry.createdAtMs)) {
      continue;
    }
    stopped.push(
      ...(await stopWindowsProcessTree(entry.pid, {
        processes: listWindowsProcesses,
        root: { createdAtMs: entry.createdAtMs },
      })),
    );
  }
  return stopped;
}
