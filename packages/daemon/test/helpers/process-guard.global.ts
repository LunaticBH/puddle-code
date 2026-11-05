import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Vitest global setup (see process-guard.ts). Windows only: the run gets a
 * temporary directory of its own, which every test process inherits as
 * TEMP and TMP, so a process whose command line names it was started by this
 * run (a fake agent, a shell started with a temporary home's hook, a
 * daemon). Any still running once the run ends is stopped, with its
 * descendants, and fails the run. A configuration loaded within a run that
 * already has a directory leaves it to that run.
 */
export default function setup(): (() => Promise<void>) | undefined {
  if (process.platform !== 'win32' || process.env.PUDDLE_TEST_RUN_DIR) return undefined;
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'puddle-run-')));
  process.env.PUDDLE_TEST_RUN_DIR = directory;
  process.env.TEMP = directory;
  process.env.TMP = directory;
  return async () => {
    const { describeProcess, stopNaming } = await import('./process-guard.js');
    const leaked = await stopNaming(directory);
    if (leaked.length > 0) {
      // Vitest reports a teardown's error but would still exit 0.
      process.exitCode = 1;
      throw new Error(
        `${leaked.length} process(es) started by this test run outlived it (stopped now):\n` +
          leaked.map((entry) => `  ${describeProcess(entry)}`).join('\n'),
      );
    }
  };
}
